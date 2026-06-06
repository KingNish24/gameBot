type Role = "crewmate" | "impostor";

export type GamePhase =
	| "lobby"
	| "mission"
	| "discussion"
	| "voting"
	| "result"
	| "ended";

export interface Player {
	id: string;
	name: string;
	role: Role | null;
	alive: boolean;
	voteCount: number;
	isBot: boolean;
}

export interface Mission {
	number: number;
	scenario: string;
	crewmateInfo: string;
}

export interface Game {
	id: string;
	channel: string;
	creator: string;
	phase: GamePhase;
	players: Map<string, Player>;
	round: number;
	maxRounds: number;
	timer: ReturnType<typeof setTimeout> | null;
	timerInterval: ReturnType<typeof setInterval> | null;
	timerMessageTs: string | null;
	votes: Map<string, string>;
	missionResponses: Map<string, string>;
	winReason: string | null;
	eliminated: string | null;
}

export interface GameStore {
	games: Map<string, Game>;
}
