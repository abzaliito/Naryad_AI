import { createApplication } from './app.mjs';

const application = createApplication();
const port = Number(process.env.PORT ?? 3001);
const server = application.app.listen(port, process.env.HOST ?? '0.0.0.0', () => {
  console.log(`НарядAI API: http://localhost:${port}`);
});
async function shutdown() {
  server.close();
  await application.close();
  server.closeAllConnections();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
