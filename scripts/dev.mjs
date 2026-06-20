import { spawn } from "node:child_process";

const children = [
  spawn("npm", ["run", "dev:api"], { stdio: "inherit" }),
  spawn("npm", ["run", "dev:vite"], { stdio: "inherit" }),
];

function shutdown(signal) {
  for (const child of children) child.kill(signal);
  process.exit(signal === "SIGINT" ? 0 : 1);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

for (const child of children) {
  child.on("exit", (code) => {
    if (code && code !== 0) shutdown("SIGTERM");
  });
}
