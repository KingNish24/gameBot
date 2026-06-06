import type { Game, GamePhase, GameStore, Player } from "./types";

const store: GameStore = { games: new Map() };

let gameIdCounter = 0;

export function getGame(channelId: string): Game | undefined {
	return store.games.get(channelId);
}

export function createGame(
	channelId: string,
	creatorId: string,
	creatorName: string,
): Game {
	gameIdCounter++;
	const id = `GAME${gameIdCounter}`;
	const game: Game = {
		id,
		channel: channelId,
		creator: creatorId,
		phase: "lobby",
		players: new Map(),
		round: 0,
		maxRounds: 3,
		timer: null,
		votes: new Map(),
		missionResponses: new Map(),
		winReason: null,
		eliminated: null,
	};
	store.games.set(channelId, game);

	// Add creator as first player
	addPlayer(game, creatorId, creatorName);
	return game;
}

export function removeGame(channelId: string): void {
	const game = store.games.get(channelId);
	if (game?.timer) clearTimeout(game.timer);
	store.games.delete(channelId);
}

export function addPlayer(
	game: Game,
	userId: string,
	userName: string,
): Player {
	const existing = game.players.get(userId);
	if (existing) return existing;

	const player: Player = {
		id: userId,
		name: userName,
		role: null,
		alive: true,
		voteCount: 0,
	};
	game.players.set(userId, player);
	return player;
}

export function removePlayer(game: Game, userId: string): boolean {
	return game.players.delete(userId);
}

export function setPhase(game: Game, phase: GamePhase): void {
	game.phase = phase;
}
