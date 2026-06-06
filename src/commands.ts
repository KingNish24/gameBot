import type {
	AllMiddlewareArgs,
	App,
	SlackCommandMiddlewareArgs,
} from "@slack/bolt";
import {
	buildEndGameBlocks,
	buildLobbyBlocks,
	buildMissionDM,
	buildResultBlocks,
	buildRoleDM,
	buildStatusBlocks,
	updateLobbyBlocks,
} from "./blocks";
import { allPlayersVoted, castVote, startGame, startVotingPhase } from "./game";
import { processVoteResults, startRound } from "./handlers";
import {
	addPlayer,
	createGame,
	getGame,
	removeGame,
	removePlayer,
} from "./store";
import type { Game } from "./types";

function getSubcommand(text: string | undefined): {
	cmd: string;
	args: string[];
} {
	if (!text || text.trim() === "") return { cmd: "", args: [] };
	const parts = text.trim().split(/\s+/);
	return { cmd: parts[0]?.toLowerCase() ?? "", args: parts.slice(1) };
}

export function registerCommands(app: App): void {
	app.command(
		"/fn-imposter",
		async (args: SlackCommandMiddlewareArgs & AllMiddlewareArgs) => {
			const { command, ack, respond, client } = args;
			await ack();

			const { cmd, args: cmdArgs } = getSubcommand(command.text);

			// ── No args: create or show game ──
			if (!cmd) {
				let game = getGame(command.channel_id);

				if (!game) {
					game = createGame(
						command.channel_id,
						command.user_id,
						command.user_name,
					);
					const blocks = buildLobbyBlocks(game);
					await client.chat.postMessage({
						token: process.env.SLACK_BOT_TOKEN,
						channel: command.channel_id,
						text: `🚀 Game ${game.id} created!`,
						blocks,
					});
					return;
				}

				const blocks = buildStatusBlocks(game);
				await respond({
					response_type: "ephemeral",
					text: `Game ${game.id} status`,
					blocks,
				});
				return;
			}

			switch (cmd) {
				// ── join ──
				case "join": {
					const game = getGame(command.channel_id);
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
							text: "Game already started! Wait for the next one.",
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

					addPlayer(game, command.user_id, command.user_name);
					await respond({
						response_type: "ephemeral",
						text: "You joined the game!",
					});

					const isCreator = game.creator === command.user_id;
					const blocks = updateLobbyBlocks(game, isCreator);
					await client.chat.postMessage({
						token: process.env.SLACK_BOT_TOKEN,
						channel: command.channel_id,
						text: `👤 <@${command.user_id}> joined the game!`,
						blocks,
					});
					return;
				}

				// ── leave ──
				case "leave": {
					const game = getGame(command.channel_id);
					if (!game) {
						await respond({
							response_type: "ephemeral",
							text: "You're not in a game.",
						});
						return;
					}
					if (game.phase !== "lobby") {
						await respond({
							response_type: "ephemeral",
							text: "Can't leave — game already started.",
						});
						return;
					}

					const removed = removePlayer(game, command.user_id);
					if (!removed) {
						await respond({
							response_type: "ephemeral",
							text: "You're not in this game.",
						});
						return;
					}

					await respond({
						response_type: "ephemeral",
						text: "You left the game.",
					});

					if (game.players.size === 0) {
						removeGame(command.channel_id);
						return;
					}

					// Reassign creator if needed
					if (game.creator === command.user_id) {
						const firstPlayer = game.players.values().next().value;
						if (firstPlayer) game.creator = firstPlayer.id;
					}

					const isCreator = game.creator === command.user_id;
					const blocks = updateLobbyBlocks(game, isCreator);
					await client.chat.postMessage({
						token: process.env.SLACK_BOT_TOKEN,
						channel: command.channel_id,
						text: `🚪 <@${command.user_id}> left the game.`,
						blocks,
					});
					return;
				}

				// ── start ──
				case "start": {
					const game = getGame(command.channel_id);
					if (!game) {
						await respond({
							response_type: "ephemeral",
							text: "No game in this channel.",
						});
						return;
					}
					if (game.creator !== command.user_id) {
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

					const err = startGame(game);
					if (err) {
						await respond({
							response_type: "ephemeral",
							text: err,
						});
						return;
					}

					const botPlayers = Array.from(game.players.values()).filter(
						(p) => p.isBot,
					);
					const botAnnouncement =
						botPlayers.length > 0
							? `\n\n🤖 *Bot players:*\n${botPlayers.map((p) => `• ${p.name}`).join("\n")}`
							: "";

					// Send role DMs (skip bots)
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

					// Announce
					const startText =
						"🚀 *GAME STARTED!*\n\n" +
						`👥 *${game.players.size} players* — ${botPlayers.length} bot(s) on board` +
						botAnnouncement +
						"\n\nRoles have been assigned. Check your *DMs*!";

					await client.chat.postMessage({
						token: process.env.SLACK_BOT_TOKEN,
						channel: command.channel_id,
						text: "🚀 Game started!",
						blocks: [
							{
								type: "section",
								text: {
									type: "mrkdwn",
									text: startText,
								},
							},
						],
					});

					// Start round 1
					await startRound(client, game);
					return;
				}

				// ── vote ──
				case "vote": {
					const game = getGame(command.channel_id);
					if (!game) {
						await respond({
							response_type: "ephemeral",
							text: "No active game.",
						});
						return;
					}
					if (game.phase !== "voting") {
						await respond({
							response_type: "ephemeral",
							text: "Voting is not open right now.",
						});
						return;
					}

					const targetUser = cmdArgs[0];
					if (!targetUser) {
						await respond({
							response_type: "ephemeral",
							text: "Usage: `/astro vote @user`\nExample: `/astro vote @alice`",
						});
						return;
					}

					const targetId = targetUser.replace(/[<@>]/g, "");
					const voteErr = castVote(game, command.user_id, targetId);
					if (voteErr) {
						await respond({
							response_type: "ephemeral",
							text: voteErr,
						});
						return;
					}

					await respond({
						response_type: "ephemeral",
						text: "🗳️ Your vote has been cast!",
					});

					if (allPlayersVoted(game)) {
						await processVoteResults(client, game);
					}
					return;
				}

				// ── status ──
				case "status": {
					const game = getGame(command.channel_id);
					if (!game) {
						await respond({
							response_type: "ephemeral",
							text: "No active game in this channel.",
						});
						return;
					}
					const blocks = buildStatusBlocks(game);
					await respond({
						response_type: "ephemeral",
						text: `Game ${game.id} status`,
						blocks,
					});
					return;
				}

				// ── cancel ──
				case "cancel": {
					const game = getGame(command.channel_id);
					if (!game) {
						await respond({
							response_type: "ephemeral",
							text: "No active game.",
						});
						return;
					}
					if (game.creator !== command.user_id) {
						await respond({
							response_type: "ephemeral",
							text: "Only the creator can cancel the game.",
						});
						return;
					}

					removeGame(command.channel_id);
					await client.chat.postMessage({
						token: process.env.SLACK_BOT_TOKEN,
						channel: command.channel_id,
						text: "Game cancelled.",
						blocks: [
							{
								type: "section",
								text: {
									type: "mrkdwn",
									text: `🗑️ *Game cancelled* by <@${command.user_id}>`,
								},
							},
						],
					});
					return;
				}

				// ── help ──
				case "help":
				default: {
					await respond({
						response_type: "ephemeral",
						text:
							"🚀 *Astronaut Impostor Commands*\n\n" +
							"`/astro` — Create a new game or show status\n" +
							"`/astro join` — Join the game\n" +
							"`/astro leave` — Leave the game\n" +
							"`/astro start` — Start the game (creator only, need 4+ players)\n" +
							"`/astro vote @user` — Vote to eject someone\n" +
							"`/astro status` — Show game status\n" +
							"`/astro cancel` — Cancel the game (creator only)",
					});
					return;
				}
			}
		},
	);
}
