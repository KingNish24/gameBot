import type { Game, Player } from "./types";

function md(text: string) {
	return { type: "mrkdwn", text } as const;
}

function plain(text: string) {
	return { type: "plain_text", text } as const;
}

function divider() {
	return { type: "divider" } as const;
}

function header(text: string) {
	return { type: "header", text: plain(text) } as const;
}

function section(text: string) {
	return { type: "section", text: md(text) } as const;
}

function context(text: string) {
	return { type: "context", elements: [md(text)] } as const;
}

function actions(elements: any[]) {
	return { type: "actions", elements } as const;
}

/** Format a player reference — Slack mention for humans, plain name for bots */
function playerRef(p: Player): string {
	return p.isBot ? p.name : `<@${p.id}>`;
}

function button(text: string, actionId: string, extra?: any) {
	return {
		type: "button",
		text: plain(text),
		action_id: actionId,
		...extra,
	} as const;
}

export function buildLobbyBlocks(game: Game): any[] {
	const playerCount = game.players.size;
	const playerList =
		playerCount === 0
			? "_No players yet._"
			: Array.from(game.players.values())
					.map((p) => `• ${playerRef(p)}`)
					.join("\n");

	const blocks: any[] = [
		header(`🚀 ASTRO IMPOSTOR (${game.id})`),
		section(`Players: *${playerCount}* / 8\n\n${playerList}`),
		divider(),
		actions([
			button("➕ Join Game", "astro_join"),
			button("🚀 Start Game", "astro_start", {
				style: "primary",
			}),
		]),
		context("At least 4 players needed. Only the game creator can start."),
	];

	return blocks;
}

/** Updated lobby blocks for the pinned message after players join/leave */
export function updateLobbyBlocks(game: Game, isCreator: boolean): any[] {
	const playerList = Array.from(game.players.values())
		.map((p) => `• ${playerRef(p)}`)
		.join("\n");

	const canStart = game.players.size >= 4 && isCreator;

	const blocks: any[] = [
		header(`🚀 ASTRO IMPOSTOR (${game.id})`),
		section(`Players: *${game.players.size}* / 8\n\n${playerList}`),
		divider(),
		actions(
			[
				button("➕ Join Game", "astro_join"),
				...(canStart
					? [button("🚀 Start Game", "astro_start", { style: "primary" })]
					: []),
			].filter(Boolean),
		),
		context(
			game.players.size < 4
				? `Need *${4 - game.players.size}* more player(s) to start.`
				: "Ready to launch! Creator can hit Start Game.",
		),
	];

	return blocks;
}

/** Role assignment DM */
export function buildRoleDM(player: Player): any[] {
	if (player.role === "impostor") {
		return [
			header("🐍 YOU ARE THE IMPOSTOR"),
			divider(),
			section(
				"*Your mission:* Blend in and deceive! 🎭\n\n" +
					"Fake your tasks, mislead the crew, and avoid suspicion. " +
					"If you survive all rounds without being ejected, *you win!*\n\n" +
					"📡 When missions come in, you *won't* see the crew's secret info — " +
					"make something up that sounds believable!\n\n" +
					"_Trust no one. Everyone is suspect._",
			),
		];
	}

	return [
		header("👨‍🚀 YOU ARE A CREWMATE"),
		divider(),
		section(
			"*Your mission:* Complete tasks and find the 🐍 Impostor!\n\n" +
				"Work together, share clues, and vote out the imposter " +
				"before they take over the ship.\n\n" +
				"📡 When missions come in, you'll receive *secret info* that only " +
				"crewmates know. The Impostor won't have this — watch for who gets it wrong!\n\n" +
				"_Stay sharp. Trust your gut._",
		),
	];
}

/** Mission DM - each player gets this */
export function buildMissionDM(
	game: Game,
	player: Player,
	scenario: string,
	crewmateInfo: string | null,
): any[] {
	const blocks: any[] = [
		header(`📡 MISSION #${game.round}`),
		section(`*Scenario:* ${scenario}`),
		divider(),
	];

	if (player.role === "crewmate" && crewmateInfo) {
		blocks.push(
			section(`*🔍 Your observation:*\n${crewmateInfo}`),
			section(
				"Respond with what you observed (be detailed but don't make it too obvious!):",
			),
		);
	} else {
		blocks.push(
			section(
				"*⚠️ You don't have any special information.*\n\n" +
					"You need to *make up a response* that sounds believable. " +
					"Look at the scenario and invent a plausible observation!",
			),
		);
	}

	blocks.push(
		actions([button("📝 Submit Mission Report", "astro_open_mission_report")]),
	);

	return blocks;
}

/** Mission report modal (opened by button in mission DM) */
export function buildMissionModal(
	game: Game,
	player: Player,
	scenario: string,
	crewmateInfo: string | null,
): any {
	const blocks: any[] = [section(`*Scenario:* ${scenario}`), divider()];

	if (player.role === "crewmate" && crewmateInfo) {
		blocks.push(section(`*🔍 Your observation:*\n${crewmateInfo}`));
	} else {
		blocks.push(
			section("*⚠️ You have no special intel.*\nMake up a believable response."),
		);
	}

	blocks.push({
		type: "input",
		block_id: "mission_input",
		element: {
			type: "plain_text_input",
			action_id: "mission_response",
			placeholder: plain("Type your observation..."),
			multiline: true,
		},
		label: plain("Your mission log:"),
	});

	return {
		type: "modal",
		callback_id: "astro_mission_report",
		title: plain(`📡 Mission #${game.round}`),
		submit: plain("Submit"),
		close: plain("Cancel"),
		private_metadata: JSON.stringify({
			channel: game.channel,
			playerId: player.id,
			round: game.round,
		}),
		blocks,
	};
}

/** Discussion blocks (posted to channel, responses anonymized) */
export function buildDiscussionBlocks(
	game: Game,
	responses: Array<{ label: string; text: string }>,
): any[] {
	const blocks: any[] = [
		header(`📡 ROUND ${game.round} — MISSION LOGS`),
		divider(),
	];

	for (const r of responses) {
		blocks.push(section(`*${r.label}:* "${r.text}"`));
	}

	blocks.push(
		divider(),
		section(
			"Discuss the logs and find the 🐍! Who is lying?\n\n" +
				"When ready, cast your vote below.",
		),
		actions([
			button("🗳️ Vote to Eject", "astro_vote_open", {
				style: "danger",
			}),
		]),
	);

	return blocks;
}
/** Voting modal */
export function buildVoteModal(game: Game): any {
	const alivePlayers = Array.from(game.players.values()).filter((p) => p.alive);

	const options = alivePlayers.map((p) => ({
		text: plain(p.name),
		value: p.id,
	}));

	return {
		type: "modal",
		callback_id: "astro_vote_modal",
		title: plain(`🗳️ Vote — Round ${game.round}`),
		submit: plain("Eject"),
		close: plain("Cancel"),
		private_metadata: game.channel,
		blocks: [
			{
				type: "section",
				text: md("Select the player you believe is the 🐍 Impostor:"),
			},
			{
				type: "input",
				block_id: "vote_block",
				element: {
					type: "static_select",
					action_id: "astro_vote_select",
					placeholder: plain("Choose a player..."),
					options,
				},
				label: plain("Who is the Impostor?"),
			},
		],
	};
}

/** Result announcement blocks */
export function buildResultBlocks(
	game: Game,
	eliminatedPlayer: Player | null,
	wasImpostor: boolean,
): any[] {
	const blocks: any[] = [
		header(`🚨 VOTE RESULTS — ROUND ${game.round}`),
		divider(),
	];

	if (eliminatedPlayer) {
		const roleEmoji = wasImpostor ? "🐍" : "👨‍🚀";
		const roleText = wasImpostor ? "the IMPOSTOR!" : "a Crewmate.";
		blocks.push(
			section(
				`${playerRef(eliminatedPlayer)} was ejected!\nThey were *${roleEmoji} ${roleText}*`,
			),
		);
	} else {
		blocks.push(
			section(
				"No one was ejected! The vote was tied or there wasn't enough evidence.",
			),
		);
	}

	// Show vote counts
	const voteLines: string[] = [];
	for (const [targetId, count] of game.votes) {
		// Count votes per target more carefully
	}

	// Tally actual counts
	const tally = new Map<string, number>();
	for (const targetId of game.votes.values()) {
		tally.set(targetId, (tally.get(targetId) ?? 0) + 1);
	}

	for (const [pid, count] of tally) {
		const p = game.players.get(pid);
		if (p) {
			voteLines.push(`• ${playerRef(p)}: ${count} vote(s)`);
		}
	}

	if (voteLines.length > 0) {
		blocks.push(section(`*Vote tally:*\n${voteLines.join("\n")}`));
	}

	// Show alive players
	const alivePlayers = Array.from(game.players.values()).filter((p) => p.alive);
	const aliveList = alivePlayers
		.map((p) => {
			return `- ${playerRef(p)}`;
		})
		.join("\n");
	blocks.push(section(`*Still in game:*\n${aliveList}`));

	return blocks;
}

/** End game screen */
export function buildEndGameBlocks(
	game: Game,
	winner: string,
	reason: string,
): any[] {
	const blocks: any[] = [
		header("🎮 GAME OVER"),
		section(winner),
		section(`*Reason:* ${reason}`),
		divider(),
	];

	const playerLines = Array.from(game.players.values()).map((p) => {
		const roleEmoji = p.role === "impostor" ? "🐍" : "👨‍🚀";
		const status = p.alive ? "" : " 💀";
		return `${roleEmoji} ${playerRef(p)}${status}`;
	});
	blocks.push(section(`*Final roster:*\n${playerLines.join("\n")}`));

	blocks.push(divider());
	blocks.push(section("Start a new game with `/astro` in any channel!"));

	return blocks;
}

/** Status blocks for /astro status */
export function buildStatusBlocks(game: Game): any[] {
	const phaseEmoji: Record<string, string> = {
		lobby: "🚀",
		mission: "📡",
		discussion: "💬",
		voting: "🗳️",
		result: "🚨",
		ended: "🎮",
	};

	const phaseNames: Record<string, string> = {
		lobby: "Lobby (waiting for players)",
		mission: "Mission in progress",
		discussion: "Discussion phase",
		voting: "Voting open",
		result: "Round result",
		ended: "Game over",
	};

	const emoji = phaseEmoji[game.phase] ?? "❓";
	const phaseName = phaseNames[game.phase] ?? game.phase;

	const blocks: any[] = [
		header(`${emoji} Game ${game.id}`),
		section(
			`*Phase:* ${phaseName}\n*Round:* ${game.round} / ${game.maxRounds}\n*Players:* ${game.players.size}`,
		),
		divider(),
	];

	// Show players
	const showRoles = game.phase === "ended";
	const playerLines = Array.from(game.players.values()).map((p) => {
		const roleEmoji = showRoles ? (p.role === "impostor" ? "🐍" : "👨‍🚀") : "";
		const status = p.alive ? "✅" : "💀";
		return `${status} ${playerRef(p)} ${roleEmoji}`;
	});
	blocks.push(section(playerLines.join("\n")));

	if (game.winReason) {
		blocks.push(divider(), section(`*Result:* ${game.winReason}`));
	}

	return blocks;
}
