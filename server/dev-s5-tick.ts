import { dailyEvolveTick } from "./src/evolve";
const msg = await dailyEvolveTick();
console.log("TICK_RESULT:", msg);
process.exit(0);
