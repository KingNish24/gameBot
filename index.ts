import "dotenv/config";
import { App } from "@slack/bolt";
import { registerCommands } from "./src/commands";
import { registerHandlers } from "./src/handlers";

const app = new App({
	token: process.env.SLACK_BOT_TOKEN,
	appToken: process.env.SLACK_APP_TOKEN,
	socketMode: true,
});

registerCommands(app);
registerHandlers(app);

app.command("/fn-ping", async ({ command, ack, respond }) => {
	const start = Date.now();
	await ack();
	const latency = Date.now() - start;
	await respond({ text: `Pong!\nLatency: ${latency}ms` });
});

(async () => {
	await app.start();
	console.log("bot is running!");
})();
