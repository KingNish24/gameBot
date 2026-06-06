import { addBotsToFill, setPhase } from "./store";
import type { Game, Mission, Player } from "./types";

export const VOTE_SKIP = "__skip__";

const MISSIONS: Mission[] = [
	{
		number: 1,
		scenario: "The navigation panel is flashing red in the cockpit.",
		crewmateInfo:
			"Course deviation detected! The instruments read 42.7° off course.",
	},
	{
		number: 2,
		scenario: "Emergency lights are flickering in the hallway.",
		crewmateInfo:
			"The circuit breaker panel behind the potted plant is tripped — sector 7G.",
	},
	{
		number: 3,
		scenario: "A strange hissing sound is coming from the air vent.",
		crewmateInfo:
			"The temperature readout on the vent shows a chilling -5°C — something's wrong with life support.",
	},
	{
		number: 4,
		scenario: "The communication array is picking up a faint signal.",
		crewmateInfo:
			"The signal repeats a pattern: three short, three long, three short ...---... (SOS in morse code).",
	},
	{
		number: 5,
		scenario: "The hydroponics bay has unusual plant growth overnight.",
		crewmateInfo:
			"The growth log shows the plants were watered with compound X-42 — that's not in the standard fertilizer.",
	},
	{
		number: 6,
		scenario: "Fuel levels are dropping faster than expected.",
		crewmateInfo:
			"The leak detection sensor points to pipe junction 3B near the engine room.",
	},
	{
		number: 7,
		scenario: "A cryptic log entry was found on the ship's computer.",
		crewmateInfo:
			"The log mentions a 'stowaway' spotted near the cargo bay at 03:00 hours.",
	},
];

export function getCurrentMission(game: Game): Mission | null {
	if (game.round < 1 || game.round > game.missionOrder.length) return null;
	const idx = game.missionOrder[game.round - 1];
	if (idx === undefined || idx < 0 || idx >= MISSIONS.length) return null;
	return MISSIONS[idx]!;
}

function shuffleArray<T>(arr: T[]): T[] {
	const copy = [...arr];
	for (let i = copy.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		[copy[i], copy[j]] = [copy[j]!, copy[i]!];
	}
	return copy;
}

export function startGame(game: Game): string | null {
	// Auto-fill with bots if fewer than 4 human players
	const humanPlayers = Array.from(game.players.values()).filter(
		(p) => !p.isBot && p.alive,
	);
	if (humanPlayers.length < 4) {
		addBotsToFill(game, 4);
	}

	const alivePlayers = Array.from(game.players.values()).filter((p) => p.alive);
	if (alivePlayers.length < 4) {
		return "Need at least 4 players to start.";
	}

	// Reset all roles and alive status
	for (const player of game.players.values()) {
		player.role = null;
		player.alive = true;
		player.voteCount = 0;
	}

	// Assign one impostor randomly
	const shuffled = shuffleArray(alivePlayers);
	shuffled[0]!.role = "impostor";
	for (let i = 1; i < shuffled.length; i++) {
		shuffled[i]!.role = "crewmate";
	}

	game.round = 0;
	game.missionOrder = shuffleArray(
		Array.from({ length: MISSIONS.length }, (_, i) => i),
	);
	game.votes = new Map();
	game.missionResponses = new Map();
	game.winReason = null;
	game.eliminated = null;
	setPhase(game, "mission");

	return null; // success
}

export function startNextRound(game: Game): void {
	game.round++;
	game.votes = new Map();
	game.missionResponses = new Map();
	game.eliminated = null;

	// Reset vote counts
	for (const player of game.players.values()) {
		player.voteCount = 0;
	}

	setPhase(game, "mission");
}

export function allPlayersResponded(game: Game): boolean {
	const alivePlayers = Array.from(game.players.values()).filter((p) => p.alive);
	return alivePlayers.every((p) => game.missionResponses.has(p.id));
}

export function submitMissionResponse(
	game: Game,
	userId: string,
	text: string,
): void {
	game.missionResponses.set(userId, text);
}

export function startVotingPhase(game: Game): void {
	setPhase(game, "voting");
}

export function allPlayersVoted(game: Game): boolean {
	const alivePlayers = Array.from(game.players.values()).filter((p) => p.alive);
	return alivePlayers.every((p) => game.votes.has(p.id));
}

export function castVote(
	game: Game,
	voterId: string,
	targetId: string,
): string | null {
	if (game.phase !== "voting") {
		return "Voting is not open right now.";
	}

	const voter = game.players.get(voterId);
	if (!voter || !voter.alive) {
		return "Only alive players can vote.";
	}

	// Allow skip vote (sentinel value) without player validation
	if (targetId === VOTE_SKIP) {
		game.votes.set(voterId, targetId);
		return null;
	}

	const target = game.players.get(targetId);
	if (!target || !target.alive) {
		return "That player is not in the game or is no longer alive.";
	}

	if (voterId === targetId) {
		return "You cannot vote for yourself.";
	}

	// Record vote (overwrites previous vote from this voter)
	game.votes.set(voterId, targetId);
	return null; // success
}

export function tallyVotes(game: Game): {
	eliminated: string | null;
	wasImpostor: boolean;
	skipCount: number;
} {
	// Count votes per target (excluding skip votes)
	const voteCounts = new Map<string, number>();
	let skipCount = 0;
	for (const targetId of game.votes.values()) {
		if (targetId === VOTE_SKIP) {
			skipCount++;
		} else {
			voteCounts.set(targetId, (voteCounts.get(targetId) ?? 0) + 1);
		}
	}

	// Update voteCount on Player objects
	for (const player of game.players.values()) {
		player.voteCount = voteCounts.get(player.id) ?? 0;
	}

	// Find max votes
	let maxVotes = 0;
	for (const count of voteCounts.values()) {
		if (count > maxVotes) maxVotes = count;
	}

	if (maxVotes === 0) {
		return { eliminated: null, wasImpostor: false, skipCount };
	}

	// Find who got max votes
	const topCandidates: string[] = [];
	for (const [id, count] of voteCounts) {
		if (count === maxVotes) topCandidates.push(id);
	}

	// Tie = no elimination
	if (topCandidates.length > 1) {
		return { eliminated: null, wasImpostor: false, skipCount };
	}

	const eliminatedId = topCandidates[0]!;
	const eliminatedPlayer = game.players.get(eliminatedId);
	const wasImpostor = eliminatedPlayer?.role === "impostor";

	// Eliminate the player
	if (eliminatedPlayer) {
		eliminatedPlayer.alive = false;
	}

	game.eliminated = eliminatedId;
	return { eliminated: eliminatedId, wasImpostor, skipCount };
}

/**
 * Check win conditions. Returns win reason string if game is over, null if game continues.
 */
export function checkWinCondition(
	game: Game,
	eliminatedId: string | null,
): string | null {
	const alivePlayers = Array.from(game.players.values()).filter((p) => p.alive);
	const impostorAlive = alivePlayers.some((p) => p.role === "impostor");

	// Crewmates win: Impostor was eliminated
	if (eliminatedId) {
		const eliminated = game.players.get(eliminatedId);
		if (eliminated?.role === "impostor") {
			game.winReason =
				"The Crewmates successfully identified and ejected the 🐍 Impostor!";
			setPhase(game, "ended");
			return game.winReason;
		}
	}

	// Impostor win: only 2 or fewer crewmates alive (impostor + 1 other)
	const crewmateCount = alivePlayers.filter(
		(p) => p.role === "crewmate",
	).length;
	if (crewmateCount <= 1 && impostorAlive) {
		game.winReason =
			"The 🐍 Impostor eliminated enough crewmates and took over the ship!";
		setPhase(game, "ended");
		return game.winReason;
	}

	// Impostor win: all rounds passed without being caught
	if (game.round >= game.maxRounds && impostorAlive) {
		game.winReason =
			"The 🐍 Impostor deceived everyone and survived all rounds!";
		setPhase(game, "ended");
		return game.winReason;
	}

	// If no impostor (shouldn't happen, but safety)
	if (!impostorAlive && eliminatedId === null) {
		game.winReason = "Something went wrong — the Impostor vanished!";
		setPhase(game, "ended");
		return game.winReason;
	}

	// Game continues
	return null;
}

export function getAnonymizedResponses(
	game: Game,
): Array<{ playerId: string; label: string; text: string }> {
	const alivePlayers = Array.from(game.players.values()).filter((p) => p.alive);
	// Shuffle to anonymize
	const shuffled = shuffleArray(alivePlayers);
	return shuffled.map((player, idx) => ({
		playerId: player.id,
		label: `Crewmate ${idx + 1}`,
		text: game.missionResponses.get(player.id) ?? "(no response)",
	}));
}
