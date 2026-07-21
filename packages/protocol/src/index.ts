export const SCAFFOLD_PING_EVENT = 'scaffold:ping';

export interface ScaffoldClientToServerEvents {
  [SCAFFOLD_PING_EVENT]: (acknowledge: (response: ScaffoldPingResponse) => void) => void;
}

export interface ScaffoldServerToClientEvents {}

export interface ScaffoldPingResponse {
  status: 'ok';
}
