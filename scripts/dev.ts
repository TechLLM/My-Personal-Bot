export {};

const procs = [
  Bun.spawn(["bun", "run", "--hot", "server/src/index.ts"], { stdout: "inherit", stderr: "inherit" }),
  Bun.spawn(["bun", "--cwd", "web", "run", "dev"], { stdout: "inherit", stderr: "inherit" }),
];
console.log("[dev] server :5274  web :5275");
process.on("SIGINT", () => { procs.forEach((p) => p.kill()); process.exit(0); });
await Promise.all(procs.map((p) => p.exited));
