import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  LOBBY_SNAPSHOT_EVENT,
  parseLobbyMutationSuccess,
  type LobbyMutationSuccess,
  type LobbySnapshotV1,
} from '@guandan/protocol';

import {
  completeLobbyCommandTransport,
  type LobbyCommandTransportDependencies,
  type LobbyTransportSocket,
} from '../src/lobby/command-transport.js';
import type { LobbySnapshotDeliveryPlan } from '../src/lobby/snapshot-delivery.js';

const COMMAND_ID = '11111111-1111-4111-8111-111111111111';
const ROOM_ID = '22222222-2222-4222-8222-222222222222';
const HOST_ID = '33333333-3333-4333-8333-333333333333';
const SECOND_ID = '44444444-4444-4444-8444-444444444444';

function snapshot(selfPlayerId = HOST_ID, revision = 0): LobbySnapshotV1 {
  const viewerIsHost = selfPlayerId === HOST_ID;
  return {
    version: 1,
    phase: 'lobby',
    roomId: ROOM_ID,
    roomCode: 'ABC234',
    revision,
    selfPlayerId,
    hostPlayerId: HOST_ID,
    settings: { startingLevel: 2, turnTimer: 'off', hasPassword: false },
    players: [
      {
        playerId: HOST_ID,
        displayName: 'Alex',
        seat: null,
        ready: false,
        connectionStatus: 'connected',
        isHost: true,
        isSelf: selfPlayerId === HOST_ID,
      },
      ...(revision === 0
        ? []
        : [
            {
              playerId: SECOND_ID,
              displayName: 'Blair',
              seat: null,
              ready: false,
              connectionStatus: 'connected' as const,
              isHost: false,
              isSelf: selfPlayerId === SECOND_ID,
            },
          ]),
    ],
    startEligibility: {
      eligible: false,
      blockers: [
        'NOT_FOUR_PLAYERS',
        'NOT_FOUR_SEATS_OCCUPIED',
        'NOT_ALL_PLAYERS_READY',
      ],
    },
    capabilities: {
      canChangeSettings: viewerIsHost,
      canManageSeats: viewerIsHost,
      canRemovePlayers: viewerIsHost,
      canStartMatch: false,
    },
  };
}

function success(revision = 0): LobbyMutationSuccess {
  return {
    status: 'ok',
    commandId: COMMAND_ID,
    roomRevision: revision,
    snapshot: snapshot(HOST_ID, revision),
  };
}

function plan(revision = 0): LobbySnapshotDeliveryPlan {
  return {
    roomId: ROOM_ID,
    revision,
    deliveries: [
      {
        socketId: 'initiator',
        playerId: HOST_ID,
        snapshot: snapshot(HOST_ID, revision),
      },
      ...(revision === 0
        ? []
        : [
            {
              socketId: 'other',
              playerId: SECOND_ID,
              snapshot: snapshot(SECOND_ID, revision),
            },
          ]),
    ],
  };
}

function socket(
  id: string,
  trace: string[],
  options: { connected?: boolean; joinError?: Error; emitError?: Error } = {},
): LobbyTransportSocket {
  return {
    id,
    connected: options.connected ?? true,
    join: async (roomId) => {
      trace.push(`join:${id}:${roomId}`);
      if (options.joinError !== undefined) throw options.joinError;
    },
    emit: (event, payload) => {
      trace.push(`emit:${id}:${event}:${payload.revision}`);
      if (options.emitError !== undefined) throw options.emitError;
    },
  };
}

type TestAcknowledgement =
  LobbyMutationSuccess | ReturnType<typeof internalError>;

function internalError(commandId: string) {
  return {
    status: 'error' as const,
    code: 'INTERNAL_ERROR' as const,
    message: 'Transport failed',
    commandId,
  };
}

function dependencies(
  initiatingSocket: LobbyTransportSocket,
  activeSockets: Map<string, LobbyTransportSocket>,
  deliveryPlan: LobbySnapshotDeliveryPlan,
  trace: string[],
): LobbyCommandTransportDependencies<
  TestAcknowledgement,
  LobbyMutationSuccess
> {
  return {
    commandKind: 'create-room' as const,
    initiatingSocket,
    getActiveSocket: (socketId: string) => activeSockets.get(socketId),
    prepareDeliveries: () => deliveryPlan,
    parseSuccess: parseLobbyMutationSuccess,
    createInternalError: internalError,
    logger: {
      info: (message: string) => trace.push(`info:${message}`),
      error: (message: string) => trace.push(`error:${message}`),
    },
  };
}

describe('lobby command transport coordinator', () => {
  it('bypasses planning and transport for command errors', async () => {
    const trace: string[] = [];
    const initiator = socket('initiator', trace);
    const acknowledgement = internalError(COMMAND_ID);
    const result = await completeLobbyCommandTransport(
      acknowledgement,
      dependencies(
        initiator,
        new Map([['initiator', initiator]]),
        plan(),
        trace,
      ),
    );
    assert.equal(result.acknowledgement, acknowledgement);
    assert.equal(result.afterAcknowledgement, undefined);
    assert.deepEqual(trace, []);
  });

  it('plans before joining and queues current initiating snapshot before acknowledgement', async () => {
    const trace: string[] = [];
    const initiator = socket('initiator', trace);
    const active = new Map([['initiator', initiator]]);
    const deps = dependencies(initiator, active, plan(), trace);
    deps.prepareDeliveries = () => {
      trace.push('plan');
      return plan();
    };

    const acknowledgement = success();
    const result = await completeLobbyCommandTransport(acknowledgement, deps);
    trace.push('ack');
    result.afterAcknowledgement?.();

    assert.equal(result.acknowledgement, acknowledgement);
    assert.deepEqual(trace.slice(0, 3), [
      'plan',
      `join:initiator:${ROOM_ID}`,
      `emit:initiator:${LOBBY_SNAPSHOT_EVENT}:0`,
    ]);
    assert.equal(
      trace.indexOf(`emit:initiator:${LOBBY_SNAPSHOT_EVENT}:0`) <
        trace.indexOf('ack'),
      true,
    );
  });

  it('returns an old receipt then emits the latest snapshot on later replay', async () => {
    const trace: string[] = [];
    const initiator = socket('initiator', trace);
    const other = socket('other', trace);
    const active = new Map([
      ['initiator', initiator],
      ['other', other],
    ]);
    const original = success(0);
    const result = await completeLobbyCommandTransport(
      original,
      dependencies(initiator, active, plan(1), trace),
    );

    assert.equal(result.acknowledgement, original);
    assert.deepEqual(result.acknowledgement, success(0));
    assert.equal(
      trace.some(
        (entry) => entry === `emit:initiator:${LOBBY_SNAPSHOT_EVENT}:1`,
      ),
      false,
    );
    trace.push(`ack:${result.acknowledgement.roomRevision}`);
    result.afterAcknowledgement?.();
    assert.deepEqual(
      trace.filter(
        (entry) => entry.startsWith('ack:') || entry.startsWith('emit:'),
      ),
      [
        'ack:0',
        `emit:initiator:${LOBBY_SNAPSHOT_EVENT}:1`,
        `emit:other:${LOBBY_SNAPSHOT_EVENT}:1`,
      ],
    );
  });

  it('reports stale post-acknowledgement initiating emission failure accurately', async () => {
    const trace: string[] = [];
    const initiator = socket('initiator', trace, {
      emitError: new Error('detail'),
    });
    const other = socket('other', trace);
    const result = await completeLobbyCommandTransport(
      success(0),
      dependencies(
        initiator,
        new Map([
          ['initiator', initiator],
          ['other', other],
        ]),
        plan(1),
        trace,
      ),
    );

    trace.push('ack:0');
    result.afterAcknowledgement?.();

    assert.deepEqual(
      trace.filter(
        (entry) => entry.startsWith('ack:') || entry.startsWith('emit:'),
      ),
      [
        'ack:0',
        `emit:initiator:${LOBBY_SNAPSHOT_EVENT}:1`,
        `emit:other:${LOBBY_SNAPSHOT_EVENT}:1`,
      ],
    );
    assert.equal(
      trace.some(
        (entry) =>
          entry.includes('emitted=1') &&
          entry.includes('failed=1') &&
          entry.includes('phase=initiator-emission-after-acknowledgement'),
      ),
      true,
    );
  });

  for (const [name, setup, phase] of [
    [
      'planning failure',
      () => ({ prepareError: new Error('detail') }),
      'planning',
    ],
    [
      'join failure',
      () => ({ joinError: new Error('detail') }),
      'channel-join',
    ],
    [
      'initiating emit failure',
      () => ({ emitError: new Error('detail') }),
      'initiator-emission',
    ],
  ] as const) {
    it(`returns sanitized command-specific error for ${name}`, async () => {
      const trace: string[] = [];
      const options = setup();
      const initiator = socket('initiator', trace, {
        ...('joinError' in options ? { joinError: options.joinError } : {}),
        ...('emitError' in options ? { emitError: options.emitError } : {}),
      });
      const active = new Map([['initiator', initiator]]);
      const deps = dependencies(initiator, active, plan(), trace);
      if ('prepareError' in options) {
        deps.prepareDeliveries = () => {
          throw options.prepareError;
        };
      }
      const result = await completeLobbyCommandTransport(success(), deps);
      assert.deepEqual(result.acknowledgement, internalError(COMMAND_ID));
      assert.equal(
        trace.some((entry) => entry.includes(`phase=${phase}`)),
        true,
      );
      if (phase === 'planning') {
        assert.equal(
          trace.some((entry) => entry.startsWith('join:')),
          false,
        );
      }
    });
  }

  it('requires the initiator to be the connected active socket', async () => {
    const trace: string[] = [];
    const initiator = socket('initiator', trace);
    const replacement = socket('initiator', trace);
    const result = await completeLobbyCommandTransport(
      success(),
      dependencies(
        initiator,
        new Map([['initiator', replacement]]),
        plan(),
        trace,
      ),
    );
    assert.deepEqual(result.acknowledgement, internalError(COMMAND_ID));
    assert.equal(
      trace.some((entry) => entry.startsWith('join:')),
      false,
    );
  });

  it('skips inactive non-initiators and continues after other emit failures', async () => {
    const cases: (undefined | { connected: false } | { emitError: Error })[] = [
      undefined,
      { connected: false },
      { emitError: new Error('detail') },
    ];

    for (const options of cases) {
      const trace: string[] = [];
      const initiator = socket('initiator', trace);
      const other =
        options === undefined ? undefined : socket('other', trace, options);
      const activeSockets = new Map([['initiator', initiator]]);
      if (other !== undefined) activeSockets.set('other', other);

      const result = await completeLobbyCommandTransport(
        success(1),
        dependencies(initiator, activeSockets, plan(1), trace),
      );

      assert.equal(result.acknowledgement.status, 'ok');
      assert.equal(
        trace.some(
          (entry) => entry === `emit:initiator:${LOBBY_SNAPSHOT_EVENT}:1`,
        ),
        true,
      );
      assert.equal(
        trace.some((entry) => entry === `emit:other:${LOBBY_SNAPSHOT_EVENT}:1`),
        other?.connected === true,
      );
    }
  });

  it('rejects missing, duplicate, mismatched, and regressed initiating plans', async () => {
    const invalidPlans = [
      { ...plan(), deliveries: [] },
      { ...plan(), deliveries: [...plan().deliveries, ...plan().deliveries] },
      { ...plan(), roomId: SECOND_ID },
      { ...plan(), revision: 0 },
    ];
    for (const [index, invalidPlan] of invalidPlans.entries()) {
      const trace: string[] = [];
      const initiator = socket('initiator', trace);
      const acknowledgement = index === 3 ? success(1) : success(0);
      const result = await completeLobbyCommandTransport(
        acknowledgement,
        dependencies(
          initiator,
          new Map([['initiator', initiator]]),
          invalidPlan,
          trace,
        ),
      );
      assert.deepEqual(result.acknowledgement, internalError(COMMAND_ID));
      assert.equal(
        trace.some((entry) => entry.startsWith('join:')),
        false,
      );
    }
  });
});
