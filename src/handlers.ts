import type {
	AllMiddlewareArgs,
	App,
	BlockAction,
	SlackActionMiddlewareArgs,
	ViewSubmitAction,
} from "@slack/bolt";
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
} from "./game";
import { addPlayer, getGame, removeGame, setPhase } from "./store";

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
				text: "No game in this channel. Create one with `/astro`",
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
		await client.chat.postMessage({
			token: process.env.SLACK_BOT_TOKEN,
			channel: channelId,
			text: `👤 <@${userId}> joined the game!`,
			blocks,
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

		// Send role DMs
		for (const player of game.players.values()) {
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

		// Announce start
		await client.chat.postMessage({
			token: process.env.SLACK_BOT_TOKEN,
			channel: channelId,
			text: "🚀 Game started!",
			blocks: [
				{
					type: "section",
					text: {
						type: "mrkdwn",
						text:
							"🚀 *GAME STARTED!*\n\n" +
							"Roles have been assigned. Check your *DMs*!",
					},
				},
			],
		});

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
		const channelId = payload.channel?.id;
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
				errors: { vote_block: "Please select a player to vote for." },
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

		await client.chat.postEphemeral({
			token: process.env.SLACK_BOT_TOKEN,
			channel: channelId,
			user: userId,
			text: "🗳️ Your vote has been recorded!",
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
			await client.chat.postMessage({
				token: process.env.SLACK_BOT_TOKEN,
				channel: channelId,
				text: "🚨 Vote Results",
				blocks: resultBlocks,
			});

			const winReason = checkWinCondition(game, eliminated);

			if (winReason) {
				const winner =
					eliminatedPlayer?.role === "impostor"
						? "*👨‍🚀 CREWMATE VICTORY!*"
						: "*🐍 IMPOSTOR VICTORY!*";
				const endBlocks = buildEndGameBlocks(game, winner, winReason);
				await client.chat.postMessage({
					token: process.env.SLACK_BOT_TOKEN,
					channel: channelId,
					text: "🎮 Game Over",
					blocks: endBlocks,
				});
			} else {
				await client.chat.postMessage({
					token: process.env.SLACK_BOT_TOKEN,
					channel: channelId,
					text: "🔄 Next round...",
					blocks: [
						{
							type: "section",
							text: {
								type: "mrkdwn",
								text: "🔄 *Next round starting soon...*",
							},
						},
					],
				});

				startNextRound(game);
				const mission = getCurrentMission(game);

				if (mission) {
					for (const player of game.players.values()) {
						if (!player.alive) continue;
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
							console.error(`Failed to send mission DM:`, err);
						}
					}

					await client.chat.postMessage({
						token: process.env.SLACK_BOT_TOKEN,
						channel: channelId,
						text: `📡 Round ${game.round}`,
						blocks: [
							{
								type: "section",
								text: {
									type: "mrkdwn",
									text: `📡 *Round ${game.round} of ${game.maxRounds}* — Check your DMs!`,
								},
							},
						],
					});
				}
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
			setPhase(game, "discussion");
			const responses = getAnonymizedResponses(game);
			const discussionBlocks = buildDiscussionBlocks(game, responses);

			await client.chat.postMessage({
				token: process.env.SLACK_BOT_TOKEN,
				channel,
				text: `📡 Round ${game.round} — Mission Logs`,
				blocks: discussionBlocks,
			});

			const DISCUSSION_TIMEOUT = 45_000;
			if (game.timer) clearTimeout(game.timer);
			game.timer = setTimeout(async () => {
				try {
					startVotingPhase(game);

					for (const player of game.players.values()) {
						if (!player.alive) continue;
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
				} catch (err) {
					console.error("Error auto-advancing to voting:", err);
				}
			}, DISCUSSION_TIMEOUT);
		}
	}) as any);
}

/** Start a round: send mission DMs, set timer */
export async function startRound(client: any, game: import("./types").Game) {
	startNextRound(game);
	const mission = getCurrentMission(game);

	if (!mission) return;

	for (const player of game.players.values()) {
		if (!player.alive) continue;
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

	await client.chat.postMessage({
		token: process.env.SLACK_BOT_TOKEN,
		channel: game.channel,
		text: `📡 Round ${game.round} has begun!`,
		blocks: [
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: `📡 *Round ${game.round} of ${game.maxRounds}* — Check your DMs for the mission!`,
				},
			},
		],
	});

	const MISSION_TIMEOUT = 60_000;
	if (game.timer) clearTimeout(game.timer);
	game.timer = setTimeout(async () => {
		try {
			for (const player of game.players.values()) {
				if (player.alive && !game.missionResponses.has(player.id)) {
					game.missionResponses.set(player.id, "(no response — time's up!)");
				}
			}
			setPhase(game, "discussion");
			const responses = getAnonymizedResponses(game);
			const discussionBlocks = buildDiscussionBlocks(game, responses);

			await client.chat.postMessage({
				token: process.env.SLACK_BOT_TOKEN,
				channel: game.channel,
				text: `📡 Round ${game.round} — Mission Logs`,
				blocks: discussionBlocks,
			});

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

async function advanceToVoting(client: any, game: import("./types").Game) {
	startVotingPhase(game);
	if (game.timer) clearTimeout(game.timer);

	for (const player of game.players.values()) {
		if (!player.alive) continue;
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
}

/** Process vote results: tally, announce, check win, advance */
export async function processVoteResults(
	client: any,
	game: import("./types").Game,
) {
	const { eliminated, wasImpostor } = tallyVotes(game);
	setPhase(game, "result");

	const eliminatedPlayer = eliminated
		? (game.players.get(eliminated) ?? null)
		: null;

	const resultBlocks = buildResultBlocks(game, eliminatedPlayer, wasImpostor);
	await client.chat.postMessage({
		token: process.env.SLACK_BOT_TOKEN,
		channel: game.channel,
		text: "🚨 Vote Results",
		blocks: resultBlocks,
	});

	const winReason = checkWinCondition(game, eliminated);

	if (winReason) {
		const winner =
			eliminatedPlayer?.role === "impostor"
				? "*👨‍🚀 CREWMATE VICTORY!*"
				: "*🐍 IMPOSTOR VICTORY!*";
		const endBlocks = buildEndGameBlocks(game, winner, winReason);
		await client.chat.postMessage({
			token: process.env.SLACK_BOT_TOKEN,
			channel: game.channel,
			text: "🎮 Game Over",
			blocks: endBlocks,
		});
	} else {
		await client.chat.postMessage({
			token: process.env.SLACK_BOT_TOKEN,
			channel: game.channel,
			text: "🔄 Next round...",
			blocks: [
				{
					type: "section",
					text: {
						type: "mrkdwn",
						text: "🔄 *Next round starting soon...*",
					},
				},
			],
		});

		await startRound(client, game);
	}
}
