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
	playerIsBot = false,
): Player {
	const existing = game.players.get(userId);
	if (existing) return existing;

	const player: Player = {
		id: userId,
		name: userName,
		role: null,
		alive: true,
		voteCount: 0,
		isBot: playerIsBot,
	};
	game.players.set(userId, player);
	return player;
}

const BOT_NAMES = ["Bot Alpha", "Bot Beta", "Bot Gamma", "Bot Delta"];

/**
 * Add bot players to reach `targetCount` human + bot players.
 * Returns the number of bots added.
 */
export function addBotsToFill(game: Game, targetCount: number): number {
	const humanCount = Array.from(game.players.values()).filter(
		(p) => !p.isBot,
	).length;

	if (humanCount >= targetCount) return 0;

	const needed = targetCount - humanCount;
	let botIndex = 0;

	for (const player of game.players.values()) {
		if (player.id.startsWith("bot-")) {
			botIndex = Math.max(
				botIndex,
				Number.parseInt(player.id.replace("bot-", ""), 10) + 1,
			);
		}
	}

	for (let i = 0; i < needed; i++) {
		const botId = `bot-${botIndex + i}`;
		const botName =
			BOT_NAMES[(botIndex + i) % BOT_NAMES.length] ?? `Bot ${botIndex + i}`;
		addPlayer(game, botId, botName, true);
	}

	return needed;
}

export function removePlayer(game: Game, userId: string): boolean {
	return game.players.delete(userId);
}

export function setPhase(game: Game, phase: GamePhase): void {
	game.phase = phase;
}
