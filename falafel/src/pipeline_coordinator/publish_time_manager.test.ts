import { BridgeConfig } from '@aztec/barretenberg/rollup_provider';
import { BridgeResolver } from '../bridge';
import { PublishTimeManager } from './publish_time_manager';

jest.useFakeTimers();

type Mockify<T> = {
  [P in keyof T]: jest.Mock;
};

let currentTime = '2021-11-11T09:30:00+00:00';
const rollupTimeoutDurationSecs = 3600;
const getCurrentTime = () => currentTime;
const stringToDate = (dateAsString: string) => new Date(dateAsString);

const bridgeConfigs: BridgeConfig[] = [
  {
    bridgeCallData: 1n,
    numTxs: 1,
    gas: 500000,
    rollupFrequency: 2,
  },
  {
    bridgeCallData: 2n,
    numTxs: 1,
    gas: 500000,
    rollupFrequency: 3,
  },
  {
    bridgeCallData: 3n,
    numTxs: 1,
    gas: 500000,
    rollupFrequency: 4,
  },
  {
    bridgeCallData: 4n,
    numTxs: 1,
    gas: 500000,
    rollupFrequency: 1,
  },
  {
    bridgeCallData: 5n,
    numTxs: 1,
    gas: 500000,
    rollupFrequency: 0,
  },
  {
    bridgeCallData: 6n,
    numTxs: 1,
    gas: 500000,
    rollupFrequency: -1,
  },
];

describe('PublishTimeManager', () => {
  let manager: PublishTimeManager;
  const bridgeResolver: Mockify<BridgeResolver> = {
    getBridgeConfigs: jest.fn().mockReturnValue(bridgeConfigs),
  } as any;

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockImplementation(() => {
      const d = stringToDate(getCurrentTime()).getTime();
      return d;
    });

    // rollup timeout is hourly
    manager = new PublishTimeManager(rollupTimeoutDurationSecs, bridgeResolver as any);
  });

  it('gives correct base timeouts', () => {
    let rollupTimeouts = manager.calculateLastTimeouts();
    expect(rollupTimeouts.baseTimeout).toEqual({
      timeout: stringToDate('2021-11-11T09:00:00+00:00'),
      rollupNumber: 454617,
    });

    rollupTimeouts = manager.calculateNextTimeouts();
    expect(rollupTimeouts.baseTimeout).toEqual({
      timeout: stringToDate('2021-11-11T10:00:00+00:00'),
      rollupNumber: 454618,
    });
  });

  it('gives no timeout if publish interval is less than 1', () => {
    manager = new PublishTimeManager(0.9, bridgeResolver as any);
    let rollupTimeouts = manager.calculateLastTimeouts();
    expect(rollupTimeouts.baseTimeout).toBeUndefined();

    rollupTimeouts = manager.calculateNextTimeouts();
    expect(rollupTimeouts.baseTimeout).toBeUndefined();
  });

  it('gives no timeout if publish interval is 0', () => {
    manager = new PublishTimeManager(0, bridgeResolver as any);
    let rollupTimeouts = manager.calculateLastTimeouts();
    expect(rollupTimeouts.baseTimeout).toBeUndefined();

    rollupTimeouts = manager.calculateNextTimeouts();
    expect(rollupTimeouts.baseTimeout).toBeUndefined();
  });

  it('gives correct bridge timeouts 1', () => {
    let rollupTimeouts = manager.calculateLastTimeouts();
    expect(rollupTimeouts.baseTimeout).toEqual({
      timeout: stringToDate('2021-11-11T09:00:00+00:00'),
      rollupNumber: 454617,
    });
    expect(rollupTimeouts.bridgeTimeouts.size).toEqual(4);
    expect(rollupTimeouts.bridgeTimeouts.get(bridgeConfigs[0].bridgeCallData)).toEqual({
      timeout: stringToDate('2021-11-11T08:00:00+00:00'),
      rollupNumber: 227308,
    });
    expect(rollupTimeouts.bridgeTimeouts.get(bridgeConfigs[1].bridgeCallData)).toEqual({
      timeout: stringToDate('2021-11-11T09:00:00+00:00'),
      rollupNumber: 151539,
    });
    expect(rollupTimeouts.bridgeTimeouts.get(bridgeConfigs[2].bridgeCallData)).toEqual({
      timeout: stringToDate('2021-11-11T08:00:00+00:00'),
      rollupNumber: 113654,
    });
    expect(rollupTimeouts.bridgeTimeouts.get(bridgeConfigs[3].bridgeCallData)).toEqual({
      timeout: stringToDate('2021-11-11T09:00:00+00:00'),
      rollupNumber: 454617,
    });

    rollupTimeouts = manager.calculateNextTimeouts();
    expect(rollupTimeouts.baseTimeout).toEqual({
      timeout: stringToDate('2021-11-11T10:00:00+00:00'),
      rollupNumber: 454618,
    });
    expect(rollupTimeouts.bridgeTimeouts.size).toEqual(4);
    expect(rollupTimeouts.bridgeTimeouts.get(bridgeConfigs[0].bridgeCallData)).toEqual({
      timeout: stringToDate('2021-11-11T10:00:00+00:00'),
      rollupNumber: 227309,
    });
    expect(rollupTimeouts.bridgeTimeouts.get(bridgeConfigs[1].bridgeCallData)).toEqual({
      timeout: stringToDate('2021-11-11T12:00:00+00:00'),
      rollupNumber: 151540,
    });
    expect(rollupTimeouts.bridgeTimeouts.get(bridgeConfigs[2].bridgeCallData)).toEqual({
      timeout: stringToDate('2021-11-11T12:00:00+00:00'),
      rollupNumber: 113655,
    });
    expect(rollupTimeouts.bridgeTimeouts.get(bridgeConfigs[3].bridgeCallData)).toEqual({
      timeout: stringToDate('2021-11-11T10:00:00+00:00'),
      rollupNumber: 454618,
    });
  });

  it('does not included bridges with rollup frequency < 1', () => {
    manager = new PublishTimeManager(rollupTimeoutDurationSecs, bridgeResolver as any);
    let rollupTimeouts = manager.calculateLastTimeouts();
    expect(rollupTimeouts.baseTimeout).toEqual({
      timeout: stringToDate('2021-11-11T09:00:00+00:00'),
      rollupNumber: 454617,
    });
    expect(rollupTimeouts.bridgeTimeouts.size).toEqual(4);
    expect(rollupTimeouts.bridgeTimeouts.get(bridgeConfigs[0].bridgeCallData)).toEqual({
      timeout: stringToDate('2021-11-11T08:00:00+00:00'),
      rollupNumber: 227308,
    });

    expect(rollupTimeouts.bridgeTimeouts.has(bridgeConfigs[4].bridgeCallData)).toBeFalsy();

    rollupTimeouts = manager.calculateNextTimeouts();
    expect(rollupTimeouts.baseTimeout).toEqual({
      timeout: stringToDate('2021-11-11T10:00:00+00:00'),
      rollupNumber: 454618,
    });
    expect(rollupTimeouts.bridgeTimeouts.size).toEqual(4);
    expect(rollupTimeouts.bridgeTimeouts.get(bridgeConfigs[0].bridgeCallData)).toEqual({
      timeout: stringToDate('2021-11-11T10:00:00+00:00'),
      rollupNumber: 227309,
    });
    expect(rollupTimeouts.bridgeTimeouts.has(bridgeConfigs[4].bridgeCallData)).toBeFalsy();
  });

  it('gives correct bridge timeouts 2', () => {
    // move the current time forward past 10:00:00
    currentTime = '2021-11-11T10:30:00+00:00';
    let rollupTimeouts = manager.calculateLastTimeouts();
    expect(rollupTimeouts.baseTimeout).toEqual({
      timeout: stringToDate('2021-11-11T10:00:00+00:00'),
      rollupNumber: 454618,
    });
    expect(rollupTimeouts.bridgeTimeouts.size).toEqual(4);
    expect(rollupTimeouts.bridgeTimeouts.get(bridgeConfigs[0].bridgeCallData)).toEqual({
      timeout: stringToDate('2021-11-11T10:00:00+00:00'),
      rollupNumber: 227309,
    });
    expect(rollupTimeouts.bridgeTimeouts.get(bridgeConfigs[1].bridgeCallData)).toEqual({
      timeout: stringToDate('2021-11-11T09:00:00+00:00'),
      rollupNumber: 151539,
    });
    expect(rollupTimeouts.bridgeTimeouts.get(bridgeConfigs[2].bridgeCallData)).toEqual({
      timeout: stringToDate('2021-11-11T08:00:00+00:00'),
      rollupNumber: 113654,
    });
    expect(rollupTimeouts.bridgeTimeouts.get(bridgeConfigs[3].bridgeCallData)).toEqual({
      timeout: stringToDate('2021-11-11T10:00:00+00:00'),
      rollupNumber: 454618,
    });

    rollupTimeouts = manager.calculateNextTimeouts();
    expect(rollupTimeouts.baseTimeout).toEqual({
      timeout: stringToDate('2021-11-11T11:00:00+00:00'),
      rollupNumber: 454619,
    });
    expect(rollupTimeouts.bridgeTimeouts.size).toEqual(4);
    expect(rollupTimeouts.bridgeTimeouts.get(bridgeConfigs[0].bridgeCallData)).toEqual({
      timeout: stringToDate('2021-11-11T12:00:00+00:00'),
      rollupNumber: 227310,
    });
    expect(rollupTimeouts.bridgeTimeouts.get(bridgeConfigs[1].bridgeCallData)).toEqual({
      timeout: stringToDate('2021-11-11T12:00:00+00:00'),
      rollupNumber: 151540,
    });
    expect(rollupTimeouts.bridgeTimeouts.get(bridgeConfigs[2].bridgeCallData)).toEqual({
      timeout: stringToDate('2021-11-11T12:00:00+00:00'),
      rollupNumber: 113655,
    });
    expect(rollupTimeouts.bridgeTimeouts.get(bridgeConfigs[3].bridgeCallData)).toEqual({
      timeout: stringToDate('2021-11-11T11:00:00+00:00'),
      rollupNumber: 454619,
    });
  });

  it('gives correct bridge timeouts on the exact rollup timout time', () => {
    // move the current time forward to 10:00:00
    currentTime = '2021-11-11T10:00:00+00:00';
    let rollupTimeouts = manager.calculateLastTimeouts();
    expect(rollupTimeouts.bridgeTimeouts.size).toEqual(4);
    expect(rollupTimeouts.baseTimeout).toEqual({
      timeout: stringToDate('2021-11-11T10:00:00+00:00'),
      rollupNumber: 454618,
    });
    expect(rollupTimeouts.bridgeTimeouts.size).toEqual(4);
    expect(rollupTimeouts.bridgeTimeouts.get(bridgeConfigs[0].bridgeCallData)).toEqual({
      timeout: stringToDate('2021-11-11T10:00:00+00:00'),
      rollupNumber: 227309,
    });
    expect(rollupTimeouts.bridgeTimeouts.get(bridgeConfigs[1].bridgeCallData)).toEqual({
      timeout: stringToDate('2021-11-11T09:00:00+00:00'),
      rollupNumber: 151539,
    });
    expect(rollupTimeouts.bridgeTimeouts.get(bridgeConfigs[2].bridgeCallData)).toEqual({
      timeout: stringToDate('2021-11-11T08:00:00+00:00'),
      rollupNumber: 113654,
    });
    expect(rollupTimeouts.bridgeTimeouts.get(bridgeConfigs[3].bridgeCallData)).toEqual({
      timeout: stringToDate('2021-11-11T10:00:00+00:00'),
      rollupNumber: 454618,
    });

    rollupTimeouts = manager.calculateNextTimeouts();
    expect(rollupTimeouts.bridgeTimeouts.size).toEqual(4);

    expect(rollupTimeouts.baseTimeout).toEqual({
      timeout: stringToDate('2021-11-11T11:00:00+00:00'),
      rollupNumber: 454619,
    });
    expect(rollupTimeouts.bridgeTimeouts.size).toEqual(4);
    expect(rollupTimeouts.bridgeTimeouts.get(bridgeConfigs[0].bridgeCallData)).toEqual({
      timeout: stringToDate('2021-11-11T12:00:00+00:00'),
      rollupNumber: 227310,
    });
    expect(rollupTimeouts.bridgeTimeouts.get(bridgeConfigs[1].bridgeCallData)).toEqual({
      timeout: stringToDate('2021-11-11T12:00:00+00:00'),
      rollupNumber: 151540,
    });
    expect(rollupTimeouts.bridgeTimeouts.get(bridgeConfigs[2].bridgeCallData)).toEqual({
      timeout: stringToDate('2021-11-11T12:00:00+00:00'),
      rollupNumber: 113655,
    });
    expect(rollupTimeouts.bridgeTimeouts.get(bridgeConfigs[3].bridgeCallData)).toEqual({
      timeout: stringToDate('2021-11-11T11:00:00+00:00'),
      rollupNumber: 454619,
    });
  });

  it('gives correct bridge timeouts considering non-UTC timezone', () => {
    // move the current time to 10:00:00 in the middle of BST, this is 09:00:00 UTC
    currentTime = '2021-06-20T10:00:00+01:00';
    let rollupTimeouts = manager.calculateLastTimeouts();
    // expect the rollup timeout to be 09:00:00 UTC
    expect(rollupTimeouts.bridgeTimeouts.size).toEqual(4);
    expect(rollupTimeouts.baseTimeout).toEqual({
      timeout: stringToDate('2021-06-20T09:00:00+00:00'),
      rollupNumber: 451161,
    });
    expect(rollupTimeouts.bridgeTimeouts.size).toEqual(4);
    expect(rollupTimeouts.bridgeTimeouts.get(bridgeConfigs[0].bridgeCallData)).toEqual({
      timeout: stringToDate('2021-06-20T08:00:00+00:00'),
      rollupNumber: 225580,
    });
    expect(rollupTimeouts.bridgeTimeouts.get(bridgeConfigs[1].bridgeCallData)).toEqual({
      timeout: stringToDate('2021-06-20T09:00:00+00:00'),
      rollupNumber: 150387,
    });
    expect(rollupTimeouts.bridgeTimeouts.get(bridgeConfigs[2].bridgeCallData)).toEqual({
      timeout: stringToDate('2021-06-20T08:00:00+00:00'),
      rollupNumber: 112790,
    });
    expect(rollupTimeouts.bridgeTimeouts.get(bridgeConfigs[3].bridgeCallData)).toEqual({
      timeout: stringToDate('2021-06-20T09:00:00+00:00'),
      rollupNumber: 451161,
    });

    rollupTimeouts = manager.calculateNextTimeouts();
    // expect the next rollup timeout to be 10:00:00 UTC
    expect(rollupTimeouts.bridgeTimeouts.size).toEqual(4);
    expect(rollupTimeouts.baseTimeout).toEqual({
      timeout: stringToDate('2021-06-20T10:00:00+00:00'),
      rollupNumber: 451162,
    });
    expect(rollupTimeouts.bridgeTimeouts.size).toEqual(4);
    expect(rollupTimeouts.bridgeTimeouts.get(bridgeConfigs[0].bridgeCallData)).toEqual({
      timeout: stringToDate('2021-06-20T10:00:00+00:00'),
      rollupNumber: 225581,
    });
    expect(rollupTimeouts.bridgeTimeouts.get(bridgeConfigs[1].bridgeCallData)).toEqual({
      timeout: stringToDate('2021-06-20T12:00:00+00:00'),
      rollupNumber: 150388,
    });
    expect(rollupTimeouts.bridgeTimeouts.get(bridgeConfigs[2].bridgeCallData)).toEqual({
      timeout: stringToDate('2021-06-20T12:00:00+00:00'),
      rollupNumber: 112791,
    });
    expect(rollupTimeouts.bridgeTimeouts.get(bridgeConfigs[3].bridgeCallData)).toEqual({
      timeout: stringToDate('2021-06-20T10:00:00+00:00'),
      rollupNumber: 451162,
    });
  });

  it('bridge timeouts are correctly a multiple of rollup timeouts', () => {
    // use a 30 minutes rollup timeout for this test
    manager = new PublishTimeManager(30 * 60, bridgeResolver as any);
    // move the current time to 11:15:00 in the middle of BST, this is 10:15:00 UTC
    currentTime = '2021-06-20T11:15:00+01:00';
    let rollupTimeouts = manager.calculateLastTimeouts();
    // expect the rollup timeout to be 10:00:00 UTC
    expect(rollupTimeouts.bridgeTimeouts.size).toEqual(4);

    expect(rollupTimeouts.baseTimeout).toEqual({
      timeout: stringToDate('2021-06-20T10:00:00+00:00'),
      rollupNumber: 902324,
    });
    expect(rollupTimeouts.bridgeTimeouts.size).toEqual(4);
    expect(rollupTimeouts.bridgeTimeouts.get(bridgeConfigs[0].bridgeCallData)).toEqual({
      timeout: stringToDate('2021-06-20T10:00:00+00:00'),
      rollupNumber: 451162,
    });
    expect(rollupTimeouts.bridgeTimeouts.get(bridgeConfigs[1].bridgeCallData)).toEqual({
      timeout: stringToDate('2021-06-20T09:00:00+00:00'),
      rollupNumber: 300774,
    });
    expect(rollupTimeouts.bridgeTimeouts.get(bridgeConfigs[2].bridgeCallData)).toEqual({
      timeout: stringToDate('2021-06-20T10:00:00+00:00'),
      rollupNumber: 225581,
    });
    expect(rollupTimeouts.bridgeTimeouts.get(bridgeConfigs[3].bridgeCallData)).toEqual({
      timeout: stringToDate('2021-06-20T10:00:00+00:00'),
      rollupNumber: 902324,
    });

    rollupTimeouts = manager.calculateNextTimeouts();
    // expect the nextrollup timeout to be 10:30:00 UTC
    expect(rollupTimeouts.bridgeTimeouts.size).toEqual(4);
    expect(rollupTimeouts.baseTimeout).toEqual({
      timeout: stringToDate('2021-06-20T10:30:00+00:00'),
      rollupNumber: 902325,
    });
    expect(rollupTimeouts.bridgeTimeouts.size).toEqual(4);
    expect(rollupTimeouts.bridgeTimeouts.get(bridgeConfigs[0].bridgeCallData)).toEqual({
      timeout: stringToDate('2021-06-20T11:00:00+00:00'),
      rollupNumber: 451163,
    });
    expect(rollupTimeouts.bridgeTimeouts.get(bridgeConfigs[1].bridgeCallData)).toEqual({
      timeout: stringToDate('2021-06-20T10:30:00+00:00'),
      rollupNumber: 300775,
    });
    expect(rollupTimeouts.bridgeTimeouts.get(bridgeConfigs[2].bridgeCallData)).toEqual({
      timeout: stringToDate('2021-06-20T12:00:00+00:00'),
      rollupNumber: 225582,
    });
    expect(rollupTimeouts.bridgeTimeouts.get(bridgeConfigs[3].bridgeCallData)).toEqual({
      timeout: stringToDate('2021-06-20T10:30:00+00:00'),
      rollupNumber: 902325,
    });
  });

  it('bridge timeouts are correctly a multiple of rollup timeouts 2', () => {
    // use a 30 minutes rollup timeout for this test
    manager = new PublishTimeManager(30 * 60, bridgeResolver as any);
    // move the current time to 11:45:00 in the middle of BST, this is 10:45:00 UTC
    currentTime = '2021-06-20T11:45:00+01:00';
    let rollupTimeouts = manager.calculateLastTimeouts();
    // expect the rollup timeout to be 10:30:00 UTC
    expect(rollupTimeouts.bridgeTimeouts.size).toEqual(4);

    expect(rollupTimeouts.baseTimeout).toEqual({
      timeout: stringToDate('2021-06-20T10:30:00+00:00'),
      rollupNumber: 902325,
    });
    expect(rollupTimeouts.bridgeTimeouts.size).toEqual(4);
    expect(rollupTimeouts.bridgeTimeouts.get(bridgeConfigs[0].bridgeCallData)).toEqual({
      timeout: stringToDate('2021-06-20T10:00:00+00:00'),
      rollupNumber: 451162,
    });
    expect(rollupTimeouts.bridgeTimeouts.get(bridgeConfigs[1].bridgeCallData)).toEqual({
      timeout: stringToDate('2021-06-20T10:30:00+00:00'),
      rollupNumber: 300775,
    });
    expect(rollupTimeouts.bridgeTimeouts.get(bridgeConfigs[2].bridgeCallData)).toEqual({
      timeout: stringToDate('2021-06-20T10:00:00+00:00'),
      rollupNumber: 225581,
    });
    expect(rollupTimeouts.bridgeTimeouts.get(bridgeConfigs[3].bridgeCallData)).toEqual({
      timeout: stringToDate('2021-06-20T10:30:00+00:00'),
      rollupNumber: 902325,
    });

    rollupTimeouts = manager.calculateNextTimeouts();
    // expect the next rollup timeout to be 11:00:00 UTC
    expect(rollupTimeouts.bridgeTimeouts.size).toEqual(4);

    expect(rollupTimeouts.baseTimeout).toEqual({
      timeout: stringToDate('2021-06-20T11:00:00+00:00'),
      rollupNumber: 902326,
    });
    expect(rollupTimeouts.bridgeTimeouts.size).toEqual(4);
    expect(rollupTimeouts.bridgeTimeouts.get(bridgeConfigs[0].bridgeCallData)).toEqual({
      timeout: stringToDate('2021-06-20T11:00:00+00:00'),
      rollupNumber: 451163,
    });
    expect(rollupTimeouts.bridgeTimeouts.get(bridgeConfigs[1].bridgeCallData)).toEqual({
      timeout: stringToDate('2021-06-20T12:00:00+00:00'),
      rollupNumber: 300776,
    });
    expect(rollupTimeouts.bridgeTimeouts.get(bridgeConfigs[2].bridgeCallData)).toEqual({
      timeout: stringToDate('2021-06-20T12:00:00+00:00'),
      rollupNumber: 225582,
    });
    expect(rollupTimeouts.bridgeTimeouts.get(bridgeConfigs[3].bridgeCallData)).toEqual({
      timeout: stringToDate('2021-06-20T11:00:00+00:00'),
      rollupNumber: 902326,
    });
  });
});
