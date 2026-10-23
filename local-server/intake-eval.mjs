import { readFileSync } from "node:fs";
import { evaluateIntakeProfile } from "../lib/intake-profile.ts";

const payload = JSON.parse(readFileSync(0, "utf8"));
if (!payload || !payload.case || !Array.isArray(payload.documents)) throw Error("Invalid intake request.");
const result = evaluateIntakeProfile(payload.case, payload.documents);
process.stdout.write(JSON.stringify(result));
