import { randomInt } from 'node:crypto';

import {
  ROOM_CODE_ALPHABET,
  parseRoomCode,
  type RoomCode,
} from '@guandan/protocol';

import {
  LobbyRepositoryInsertError,
  type LobbyRepository,
} from './repository.js';

export const MAX_ROOM_CODE_ATTEMPTS = 32;
export type RoomCodeCandidateGenerator = () => string;

export interface RoomCodeAllocator {
  allocate<T>(accept: (roomCode: RoomCode) => T): T | undefined;
}

export function createRoomCodeCandidate(): RoomCode {
  let candidate = '';
  for (let index = 0; index < 6; index += 1) {
    candidate += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
  }
  return candidate;
}

export function createRoomCodeAllocator(
  repository: Pick<LobbyRepository, 'hasRoomCode'>,
  generateCandidate: RoomCodeCandidateGenerator = createRoomCodeCandidate,
): RoomCodeAllocator {
  return {
    allocate<T>(accept: (roomCode: RoomCode) => T): T | undefined {
      for (let attempt = 0; attempt < MAX_ROOM_CODE_ATTEMPTS; attempt += 1) {
        const candidate = parseRoomCode(generateCandidate());
        if (candidate === undefined) {
          throw new Error('Room-code generator returned an invalid candidate');
        }
        if (repository.hasRoomCode(candidate)) {
          continue;
        }

        try {
          return accept(candidate);
        } catch (error: unknown) {
          if (
            error instanceof LobbyRepositoryInsertError &&
            error.failure === 'duplicate-room-code'
          ) {
            continue;
          }
          throw error;
        }
      }
      return undefined;
    },
  };
}
