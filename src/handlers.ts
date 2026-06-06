import type {
	AllMiddlewareArgs,
	App,
	BlockAction,
	SlackActionMiddlewareArgs,
	ViewSubmitAction,
} from "@slack/bolt";
import { generateMissionResponse, generateVote } from "./ai";
import {
	buildDiscussionBlocks,
	buildEndGameBlocks,
	buildMissionDM,
	buildMissionModal,
	buildResultBlocks,
	buildRoleDM,
	buildVoteModal,
	updateLobbyBlocks,
} from "./blocks";
import {
	allPlayersResponded,
	allPlayersVoted,
	castVote,
	checkWinCondition,
	getAnonymizedResponses,
	getCurrentMission,
	startNextRound,
	startVotingPhase,
	submitMissionResponse,
	tallyVotes,
	VOTE_SKIP,
} from "./game";
import { addPlayer, getGame, setPhase } from "./store";

type ActionHandler = (
	args: SlackActionMiddlewareArgs & AllMiddlewareArgs,
) => Promise<void>;

export function registerHandlers(app: App): void {
	// ── Join Game button ──
	app.action("astro_join", (async (args) => {
		const { ack, body, client, respond } = args;
		await ack();

		const payload = body as unknown as BlockAction;
		const channelId = payload.channel?.id;
		const userId = payload.user?.id;
		const userName = payload.user?.name ?? userId;

		if (!channelId || !userId) return;

		const game = getGame(channelId);
		if (!game) {
			await respond({
				response_type: "ephemeral",
				text: "No game in this channel. Create one with `/fn-imposter`",
			});
			return;
		}

		if (game.phase !== "lobby") {
			await respond({
				response_type: "ephemeral",
				text: "Game already started!",
			});
			return;
		}

		if (game.players.size >= 8) {
			await respond({
				response_type: "ephemeral",
				text: "Game is full (max 8 players).",
			});
			return;
		}

		addPlayer(game, userId, userName!);

		const isCreator = game.creator === userId;
		const blocks = updateLobbyBlocks(game, isCreator);
		if (game.mainMessageTs) {
			await client.chat.update({
				token: process.env.SLACK_BOT_TOKEN,
				channel: channelId,
				ts: game.mainMessageTs,
				text: `🚀 Game ${game.id} (${game.players.size} players)`,
				blocks,
			});
		}
		await client.chat.postMessage({
			token: process.env.SLACK_BOT_TOKEN,
			channel: channelId,
			text: `👤 <@${userId}> joined the game!`,
		});
	}) as ActionHandler);

	// ── Start Game button ──
	app.action("astro_start", (async (args) => {
		const { ack, body, client, respond } = args;
		await ack();

		const payload = body as unknown as BlockAction;
		const channelId = payload.channel?.id;
		const userId = payload.user?.id;

		if (!channelId || !userId) return;

		const game = getGame(channelId);
		if (!game) {
			await respond({
				response_type: "ephemeral",
				text: "No game in this channel.",
			});
			return;
		}

		if (game.creator !== userId) {
			await respond({
				response_type: "ephemeral",
				text: "Only the game creator can start.",
			});
			return;
		}

		if (game.phase !== "lobby") {
			await respond({
				response_type: "ephemeral",
				text: "Game already in progress.",
			});
			return;
		}

		const { startGame } = await import("./game");
		const err = startGame(game);
		if (err) {
			await respond({ response_type: "ephemeral", text: err });
			return;
		}

		// Collect bot info for announcement
		const botPlayers = Array.from(game.players.values()).filter((p) => p.isBot);
		const botAnnouncement =
			botPlayers.length > 0
				? `\n\n🤖 *Bot players have joined:*\n${botPlayers.map((p) => `• ${p.name}`).join("\n")}`
				: "";

		// Send role DMs
		for (const player of game.players.values()) {
			if (player.isBot) continue;
			try {
				const blocks = buildRoleDM(player);
				await client.chat.postMessage({
					token: process.env.SLACK_BOT_TOKEN,
					channel: player.id,
					text: `You are a ${player.role}!`,
					blocks,
				});
			} catch (dmErr) {
				console.error(`Failed to DM ${player.name}:`, dmErr);
			}
		}

		// Update lobby message to show game in progress
		if (game.mainMessageTs) {
			await client.chat.update({
				token: process.env.SLACK_BOT_TOKEN,
				channel: channelId,
				ts: game.mainMessageTs,
				text: `🚀 Game ${game.id} in progress`,
				blocks: [
					{
						type: "section",
						text: {
							type: "mrkdwn",
							text: `🚀 *Game ${game.id}* — Game in progress! Round ${game.round}`,
						},
					},
				],
			});
		}

		// Announce start as threaded reply under main message
		const humanPlayerList = Array.from(game.players.values())
			.filter((p) => !p.isBot)
			.map((p) => `• <@${p.id}>`)
			.join("\n");
		const startText =
			"🚀 *GAME STARTED!*\n\n" +
			`👥 *Players (${game.players.size})*\n${humanPlayerList}\n` +
			botAnnouncement +
			"\n\nRoles have been assigned. Check your *DMs*!";

		const startBlocks = [
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: startText,
				},
			},
		];

		if (game.mainMessageTs) {
			await client.chat.postMessage({
				token: process.env.SLACK_BOT_TOKEN,
				channel: channelId,
				thread_ts: game.mainMessageTs,
				text: "🚀 Game started!",
				blocks: startBlocks,
			});
		} else {
			await client.chat.postMessage({
				token: process.env.SLACK_BOT_TOKEN,
				channel: channelId,
				text: "🚀 Game started!",
				blocks: startBlocks,
			});
		}

		// Start first round
		await startRound(client, game);
	}) as ActionHandler);

	// ── Open voting modal button ──
	app.action("astro_vote_open", (async (args) => {
		const { ack, body, client } = args;
		await ack();

		const payload = body as unknown as BlockAction;
		const channelId = payload.channel?.id;
		if (!channelId) return;

		const game = getGame(channelId);
		if (!game) return;

		const modal = buildVoteModal(game);
		try {
			await client.views.open({
				token: process.env.SLACK_BOT_TOKEN,
				trigger_id: (payload as any).trigger_id,
				view: modal,
			});
		} catch (err) {
			console.error("Failed to open vote modal:", err);
		}
	}) as ActionHandler);

	// ── Open mission report modal ──
	app.action("astro_open_mission_report", (async (args) => {
		const { ack, body, client } = args;
		await ack();

		const payload = body as unknown as BlockAction;
		const userId = payload.user?.id;
		// Button value carries the public game channel (button is in a DM)
		const channelId =
			(payload.actions?.[0] as any)?.value ?? payload.channel?.id;
		if (!channelId || !userId) return;

		const game = getGame(channelId);
		if (!game || game.phase !== "mission") return;

		const player = game.players.get(userId);
		if (!player || !player.alive) return;

		const mission = getCurrentMission(game);
		if (!mission) return;

		const modal = buildMissionModal(
			game,
			player,
			mission.scenario,
			player.role === "crewmate" ? mission.crewmateInfo : null,
		);

		try {
			await client.views.open({
				token: process.env.SLACK_BOT_TOKEN,
				trigger_id: (payload as any).trigger_id,
				view: modal,
			});
		} catch (err) {
			console.error("Failed to open mission report modal:", err);
		}
	}) as ActionHandler);

	// ── Vote modal submission ──
	app.view("astro_vote_modal", (async (args: any) => {
		const { ack, body, client } = args;
		const payload = body as unknown as ViewSubmitAction;

		const channelId = payload.view.private_metadata;
		const userId = payload.user?.id;
		const values = payload.view.state.values;

		if (!channelId || !userId) return;

		const game = getGame(channelId);
		if (!game) return;

		const voteBlock = values["vote_block"];
		const selectAction = voteBlock?.["astro_vote_select"];
		const targetId = selectAction?.selected_option?.value;

		if (!targetId) {
			await ack({
				response_action: "errors",
				errors: { vote_block: "Please select a player or skip." },
			});
			return;
		}

		await ack();

		const err = castVote(game, userId, targetId);
		if (err) {
			await client.chat.postEphemeral({
				token: process.env.SLACK_BOT_TOKEN,
				channel: channelId,
				user: userId,
				text: `❌ ${err}`,
			});
			return;
		}

		const voteLabel =
			targetId === "__skip__"
				? "⏭️ You chose to skip!"
				: "🗳️ Your vote has been recorded!";
		await client.chat.postEphemeral({
			token: process.env.SLACK_BOT_TOKEN,
			channel: channelId,
			user: userId,
			text: voteLabel,
		});

		if (allPlayersVoted(game)) {
			const { eliminated, wasImpostor } = tallyVotes(game);
			setPhase(game, "result");

			const eliminatedPlayer = eliminated
				? (game.players.get(eliminated) ?? null)
				: null;

			const resultBlocks = buildResultBlocks(
				game,
				eliminatedPlayer,
				wasImpostor,
			);
			await postInThread(client, game, "🚨 Vote Results", resultBlocks);

			const winReason = checkWinCondition(game, eliminated);

			if (winReason) {
				const winner =
					eliminatedPlayer?.role === "impostor"
						? "*👨‍🚀 CREWMATE VICTORY!*"
						: "*🐍 IMPOSTOR VICTORY!*";
				const endBlocks = buildEndGameBlocks(game, winner, winReason);
				await postInThread(client, game, "🎮 Game Over", endBlocks);
			} else {
				await startRound(client, game);
			}
		}
	}) as any);

	// ── Mission report modal submission ──
	app.view("astro_mission_report", (async (args: any) => {
		const { ack, body, client } = args;
		const payload = body as unknown as ViewSubmitAction;

		let metadata: { channel: string; playerId: string; round: number };
		try {
			metadata = JSON.parse(payload.view.private_metadata);
		} catch {
			await ack();
			return;
		}

		const { channel, playerId, round } = metadata;
		const values = payload.view.state.values;
		const missionInput = values["mission_input"];
		const responseText = missionInput?.["mission_response"]?.value?.trim();

		if (!responseText) {
			await ack({
				response_action: "errors",
				errors: {
					mission_input: "Please enter your observation.",
				},
			});
			return;
		}

		await ack();

		const game = getGame(channel);
		if (!game || game.round !== round) {
			await client.chat.postEphemeral({
				token: process.env.SLACK_BOT_TOKEN,
				channel,
				user: playerId,
				text: "This mission round is no longer active.",
			});
			return;
		}

		submitMissionResponse(game, playerId, responseText);

		await client.chat.postEphemeral({
			token: process.env.SLACK_BOT_TOKEN,
			channel,
			user: playerId,
			text: "✅ Mission report submitted!",
		});

		if (allPlayersResponded(game)) {
			await clearTimerDisplay(game);
			setPhase(game, "discussion");
			const responses = getAnonymizedResponses(game);
			const discussionBlocks = buildDiscussionBlocks(game, responses);

			await postInThread(
				client,
				game,
				`📡 Round ${game.round} — Mission Logs`,
				discussionBlocks,
			);

			// Main message: discussion header + timer
			const discussionBaseBlocks = [
				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: `💬 *Discussion — Round ${game.round}*`,
					},
				},
			];
			startTimerDisplay(
				client,
				game,
				discussionBaseBlocks,
				45_000,
				"💬 Discussion",
			);

			const DISCUSSION_TIMEOUT = 45_000;
			if (game.timer) clearTimeout(game.timer);
			game.timer = setTimeout(async () => {
				try {
					await clearTimerDisplay(game);
					startVotingPhase(game);

					// Main message: voting header + timer
					const votingBaseBlocks = [
						{
							type: "section",
							text: {
								type: "mrkdwn",
								text: `🗳️ *Voting — Round ${game.round}*\n\nTime to vote! Check the button in your DMs.`,
							},
						},
					];
					startTimerDisplay(client, game, votingBaseBlocks, 30_000, "🗳️ Voting");

					for (const player of game.players.values()) {
						if (!player.alive || player.isBot) continue;
						await client.chat.postEphemeral({
							token: process.env.SLACK_BOT_TOKEN,
							channel,
							user: player.id,
							text: "🗳️ Voting is now open!",
							blocks: [
								{
									type: "actions",
									elements: [
										{
											type: "button",
											text: {
												type: "plain_text",
												text: "🗳️ Vote to Eject",
											},
											action_id: "astro_vote_open",
											style: "danger",
										},
									],
								},
							],
						});
					}

					// Voting timeout: auto-fill non-voters with skip
					game.timer = setTimeout(async () => {
						try {
							await clearTimerDisplay(game);
							for (const p of game.players.values()) {
								if (p.alive && !game.votes.has(p.id)) {
									game.votes.set(p.id, VOTE_SKIP);
								}
							}
							if (allPlayersVoted(game)) {
								await processVoteResults(client, game);
							}
						} catch (err) {
							console.error("Error during voting timeout:", err);
						}
					}, 30_000);
				} catch (err) {
					console.error("Error auto-advancing to voting:", err);
				}
			}, DISCUSSION_TIMEOUT);
		}
	}) as any);
}

/** Post or update the main message with base blocks + timer countdown */
async function startTimerDisplay(
	client: any,
	game: import("./types").Game,
	baseBlocks: any[],
	durationMs: number,
	label: string,
) {
	await clearTimerDisplay(game);
	const startTime = Date.now();

	const updateTimer = async (remaining: number) => {
		const blocks = [
			...baseBlocks,
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: `⏱️ *${label}* — \`${remaining}s\` remaining`,
				},
			},
		];

		if (!game.mainMessageTs) {
			const msg = await client.chat.postMessage({
				token: process.env.SLACK_BOT_TOKEN,
				channel: game.channel,
				text: `⏱️ ${label}: ${remaining}s`,
				blocks,
			});
			game.mainMessageTs = msg.ts as string;
		} else {
			await client.chat.update({
				token: process.env.SLACK_BOT_TOKEN,
				channel: game.channel,
				ts: game.mainMessageTs,
				text: `⏱️ ${label}: ${remaining}s`,
				blocks,
			});
		}
	};

	await updateTimer(Math.floor(durationMs / 1000));

	game.timerInterval = setInterval(async () => {
		const remaining = Math.max(
			0,
			Math.ceil((durationMs - (Date.now() - startTime)) / 1000),
		);
		if (!game.mainMessageTs) return;
		try {
			await updateTimer(remaining);
		} catch (err) {
			console.error("Failed to update timer display:", err);
		}
	}, 1000);
}

/** Clear timer interval only — main message stays */
async function clearTimerDisplay(game: import("./types").Game) {
	if (game.timerInterval) {
		clearInterval(game.timerInterval);
		game.timerInterval = null;
	}
}

/** Post a message as a threaded reply under the main message */
async function postInThread(
	client: any,
	game: import("./types").Game,
	text: string,
	blocks: any[],
): Promise<void> {
	if (!game.mainMessageTs) {
		await client.chat.postMessage({
			token: process.env.SLACK_BOT_TOKEN,
			channel: game.channel,
			text,
			blocks,
		});
		return;
	}
	await client.chat.postMessage({
		token: process.env.SLACK_BOT_TOKEN,
		channel: game.channel,
		thread_ts: game.mainMessageTs,
		text,
		blocks,
	});
}

/** Start a round: send mission DMs, set timer, trigger bot AI responses */
export async function startRound(client: any, game: import("./types").Game) {
	startNextRound(game);
	const mission = getCurrentMission(game);

	if (!mission) return;

	const alivePlayers = Array.from(game.players.values()).filter((p) => p.alive);

	// Send mission DMs to human players only
	for (const player of alivePlayers) {
		if (player.isBot) continue;
		try {
			const dmBlocks = buildMissionDM(
				game,
				player,
				mission.scenario,
				player.role === "crewmate" ? mission.crewmateInfo : null,
			);
			await client.chat.postMessage({
				token: process.env.SLACK_BOT_TOKEN,
				channel: player.id,
				text: `📡 Mission #${game.round}`,
				blocks: dmBlocks,
			});
		} catch (err) {
			console.error(`Failed to send mission DM to ${player.name}:`, err);
		}
	}

	// Main message: round info + "Check your DMs" + timer
	const missionBaseBlocks = [
		{
			type: "section",
			text: {
				type: "mrkdwn",
				text: `📡 *Round ${game.round} of ${game.maxRounds}* — Check your DMs for the mission!`,
			},
		},
	];
	startTimerDisplay(client, game, missionBaseBlocks, 60_000, "📡 Mission");

	// Trigger AI responses for bot players
	const botPlayers = alivePlayers.filter((p) => p.isBot);
	if (botPlayers.length > 0) {
		// Fire bot responses asynchronously (non-blocking)
		processBotMissionResponses(game, mission.scenario, botPlayers);
	}

	const MISSION_TIMEOUT = 60_000;
	if (game.timer) clearTimeout(game.timer);
	game.timer = setTimeout(async () => {
		try {
			for (const player of alivePlayers) {
				if (!game.missionResponses.has(player.id)) {
					game.missionResponses.set(player.id, "(no response — time's up!)");
				}
			}
			setPhase(game, "discussion");
			const responses = getAnonymizedResponses(game);
			const discussionBlocks = buildDiscussionBlocks(game, responses);

			await clearTimerDisplay(game);

			await postInThread(
				client,
				game,
				`📡 Round ${game.round} — Mission Logs`,
				discussionBlocks,
			);

			// Main message: discussion header + timer
			const discussionBaseBlocks = [
				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: `💬 *Discussion — Round ${game.round}*`,
					},
				},
			];
			startTimerDisplay(
				client,
				game,
				discussionBaseBlocks,
				45_000,
				"💬 Discussion",
			);

			// Then auto-advance to voting
			const DISCUSSION_TIMEOUT = 45_000;
			game.timer = setTimeout(async () => {
				try {
					await advanceToVoting(client, game);
				} catch (err) {
					console.error("Error auto-advancing:", err);
				}
			}, DISCUSSION_TIMEOUT);
		} catch (err) {
			console.error("Error auto-advancing mission:", err);
		}
	}, MISSION_TIMEOUT);
}

/** Generate AI mission responses for all bot players */
async function processBotMissionResponses(
	game: import("./types").Game,
	scenario: string,
	botPlayers: import("./types").Player[],
): Promise<void> {
	const allPlayers = Array.from(game.players.values());
	const mission = getCurrentMission(game);

	for (const bot of botPlayers) {
		try {
			const response = await generateMissionResponse(
				bot,
				scenario,
				bot.role === "crewmate" && mission ? mission.crewmateInfo : null,
				allPlayers,
			);
			submitMissionResponse(game, bot.id, response);
			console.log(
				`Bot ${bot.name} submitted mission response: "${response.substring(0, 60)}..."`,
			);
		} catch (err) {
			console.error(`Bot ${bot.name} mission response failed:`, err);
		}
	}
}

async function advanceToVoting(client: any, game: import("./types").Game) {
	startVotingPhase(game);
	if (game.timer) clearTimeout(game.timer);
	await clearTimerDisplay(game);

	const alivePlayers = Array.from(game.players.values()).filter((p) => p.alive);

	// Send voting buttons to human players only
	for (const player of alivePlayers) {
		if (player.isBot) continue;
		try {
			await client.chat.postEphemeral({
				token: process.env.SLACK_BOT_TOKEN,
				channel: game.channel,
				user: player.id,
				text: "🗳️ Voting is now open!",
				blocks: [
					{
						type: "actions",
						elements: [
							{
								type: "button",
								text: { type: "plain_text", text: "🗳️ Vote to Eject" },
								action_id: "astro_vote_open",
								style: "danger",
							},
						],
					},
				],
			});
		} catch (err) {
			console.error(`Failed to send vote ephemeral:`, err);
		}
	}

	// Trigger AI votes for bot players
	const botPlayers = alivePlayers.filter((p) => p.isBot);
	if (botPlayers.length > 0) {
		processBotVotes(client, game, botPlayers);
	}

	// Main message: voting header + timer
	const votingBaseBlocks = [
		{
			type: "section",
			text: {
				type: "mrkdwn",
				text: `🗳️ *Voting — Round ${game.round}*\n\nTime to vote! Check the button in your DMs.`,
			},
		},
	];
	startTimerDisplay(client, game, votingBaseBlocks, 30_000, "🗳️ Voting");

	const VOTE_TIMEOUT = 30_000;
	if (game.timer) clearTimeout(game.timer);
	game.timer = setTimeout(async () => {
		try {
			await clearTimerDisplay(game);
			// Fill non-voters with skip
			for (const p of game.players.values()) {
				if (p.alive && !game.votes.has(p.id)) {
					game.votes.set(p.id, VOTE_SKIP);
				}
			}
			if (allPlayersVoted(game)) {
				await processVoteResults(client, game);
			}
		} catch (err) {
			console.error("Error during voting timeout:", err);
		}
	}, VOTE_TIMEOUT);
}

/** Generate AI votes for all bot players, then auto-process if all votes are in */
async function processBotVotes(
	client: any,
	game: import("./types").Game,
	botPlayers: import("./types").Player[],
): Promise<void> {
	const alivePlayers = Array.from(game.players.values()).filter((p) => p.alive);
	const responses = getAnonymizedResponses(game);
	const mission = getCurrentMission(game);
	const scenario = mission?.scenario ?? "";

	for (const bot of botPlayers) {
		try {
			const targetId = await generateVote(
				bot,
				responses,
				alivePlayers,
				scenario,
			);

			const err = castVote(game, bot.id, targetId);
			if (err) {
				console.error(`Bot ${bot.name} vote failed: ${err}`);
				continue;
			}
			console.log(`Bot ${bot.name} voted for target ${targetId}`);
		} catch (err) {
			console.error(`Bot ${bot.name} vote failed:`, err);
		}
	}

	// After all bot votes are in, check if ALL players have voted
	// (bots + any humans who already voted). If so, process results.
	if (allPlayersVoted(game)) {
		await processVoteResults(client, game);
	}
}

/** Process vote results: tally, announce, check win, advance */
export async function processVoteResults(
	client: any,
	game: import("./types").Game,
) {
	await clearTimerDisplay(game);
	const { eliminated, wasImpostor } = tallyVotes(game);
	setPhase(game, "result");

	const eliminatedPlayer = eliminated
		? (game.players.get(eliminated) ?? null)
		: null;

	const resultBlocks = buildResultBlocks(game, eliminatedPlayer, wasImpostor);
	await postInThread(client, game, "🚨 Vote Results", resultBlocks);

	const winReason = checkWinCondition(game, eliminated);

	if (winReason) {
		const winner =
			eliminatedPlayer?.role === "impostor"
				? "*👨‍🚀 CREWMATE VICTORY!*"
				: "*🐍 IMPOSTOR VICTORY!*";
		const endBlocks = buildEndGameBlocks(game, winner, winReason);
		await postInThread(client, game, "🎮 Game Over", endBlocks);
	} else {
		await startRound(client, game);
	}
}
