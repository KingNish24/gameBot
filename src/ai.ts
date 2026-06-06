import type { Player } from "./types";

const BASE_URL = process.env.AI_BASE_URL;
const API_KEY = process.env.AI_API_KEY;
const MODEL = process.env.AI_MODEL;

interface Choice {
	message: { content: string };
}

interface ApiResponse {
	choices: Choice[];
}

async function callAI(
	systemPrompt: string,
	userPrompt: string,
): Promise<string> {
	const maxRetries = 3;
	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			const res = await fetch(`${BASE_URL}/chat/completions`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${API_KEY}`,
				},
				body: JSON.stringify({
					model: MODEL,
					messages: [
						{ role: "system", content: systemPrompt },
						{ role: "user", content: userPrompt },
					],
					max_tokens: 3000,
				}),
			});

			if (!res.ok) {
				console.error(
					`AI API error (attempt ${attempt}/${maxRetries}): ${res.status} ${res.statusText}`,
				);
				if (attempt < maxRetries) continue;
				return "(no response)";
			}

			const data = (await res.json()) as ApiResponse;
			const content = data.choices[0]?.message?.content?.trim();
			if (content) return content;
		} catch (err) {
			console.error(`AI call failed (attempt ${attempt}/${maxRetries}):`, err);
			if (attempt < maxRetries) continue;
		}
	}
	return "(no response)";
}

/**
 * Generate a mission log entry for a bot player.
 */
export async function generateMissionResponse(
	player: Player,
	scenario: string,
	crewmateInfo: string | null,
	allPlayers: Player[],
): Promise<string> {
	const playerList = allPlayers
		.filter((p) => p.alive && p.id !== player.id)
		.map((p) => p.name)
		.join(", ");

	if (player.role === "crewmate" && crewmateInfo) {
		const systemPrompt =
			"You are a crewmate on a spaceship. You noticed a clue and are writing a mission log entry. " +
			"Write a natural in-character log entry incorporating the clue naturally — don't make it too obvious you have inside info. " +
			"Keep it 1-3 sentences. No markdown, no asterisks, just plain text.";

		const userPrompt = [
			`Scenario: ${scenario}`,
			`Your clue (only you know this): ${crewmateInfo}`,
			`Other crewmates on this mission: ${playerList || "none"}`,
			"\nWrite your mission log entry:",
		].join("\n");

		return callAI(systemPrompt, userPrompt);
	}

	// Impostor (or crewmate without info — edge case)
	const systemPrompt =
		"You are an impostor hiding among a spaceship crew. You need to write a fake mission log entry " +
		"that sounds believable so the crew doesn't suspect you. Mention a made-up observation related to the scenario. " +
		"Keep it 1-3 sentences. No markdown, no asterisks, just plain text.";

	const userPrompt = [
		`Scenario: ${scenario}`,
		`Other crewmates on this mission: ${playerList || "none"}`,
		"\nWrite your fake mission log entry (make it sound convincing):",
	].join("\n");

	return callAI(systemPrompt, userPrompt);
}

/**
 * Decide which player to vote for as a bot player.
 * Returns the target player ID.
 */
export async function generateVote(
	player: Player,
	anonymizedResponses: Array<{ label: string; playerId: string; text: string }>,
	alivePlayers: Player[],
	scenario: string,
): Promise<string> {
	// If only one other alive player, vote for them
	const others = alivePlayers.filter((p) => p.id !== player.id && p.alive);
	if (others.length <= 1) {
		return others[0]?.id ?? player.id;
	}

	const responsesText = anonymizedResponses
		.filter((r) => r.playerId !== player.id)
		.map((r) => `${r.label}: "${r.text}"`)
		.join("\n");

	const suspectNames = others.map((p) => p.name).join(", ");

	const systemPrompt =
		"You are playing a social deduction game (like Among Us) on a spaceship. " +
		"One player is the impostor. Read the mission log entries from each crewmate below. " +
		"Based on who seems suspicious, decide who to vote out. " +
		"Respond with ONLY the name of the player you vote for, nothing else.";

	const userPrompt = [
		`Mission scenario: ${scenario}`,
		"\nCrewmate mission log entries:",
		responsesText,
		`\nPlayers you can vote for: ${suspectNames}`,
		"\nWho do you vote to eject? Do not reply with anything elese. Do not think out loud. Just Reply with just the name:",
	].join("\n");

	const result = await callAI(systemPrompt, userPrompt);

	// Match the returned name to a player ID
	const matched = others.find(
		(p) =>
			result.toLowerCase().includes(p.name.toLowerCase()) ||
			p.name.toLowerCase().includes(result.toLowerCase()),
	);

	console.log(
		`Bot ${player.name} voted for "${result}" (matched: ${matched?.name})`,
	);

	const fallback = others[Math.floor(Math.random() * others.length)];
	return matched?.id ?? fallback?.id ?? player.id;
}
