import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { OwnershipParser } from "../lib/document-ingestion.ts";
const parser = new OwnershipParser();
const clean = readFileSync("tests/fixtures/ontario-ownership-ocr.txt", "utf8");
const traps = `ONTARIO VEHICLE PERMIT / CERTIFICAT D'IMMATRICULATION
NAME / NOM
Please print clearly
NAME / NOM
Office Use Only
NAME / NOM
DELTA, TEST
NAME / NOM
THETA, TEST
ADDRESS / ADRESSE
change, detach here
PLATE / PLAQUE
PAS - FIT
VIN: ZZZTESTA0T0000001
VIN: ZZZTESTA0T000000I`;
const ambiguous = await parser.parse({ text: traps, confidence: .99 });
for (const field of ["registeredOwner", "ownerAddress", "plate"]) { assert.equal(ambiguous.data[field], undefined); assert.ok(ambiguous.warnings.some(w => w.field === field && w.code === "NEEDS_REVIEW")); }
assert.equal(ambiguous.data.vin, "ZZZTESTA0T0000001");
for (const noise of ["ZZZTESTA0T000000I", "ZZZTESTA0T000000", "AZZZTESTA0T0000001", "ZZZTESTA0T000000O"]) assert.equal((await parser.parse({ text: `VIN: ${noise}` })).data.vin, undefined);
for (const label of ["Please print clearly", "Office Use Only", "A l'usage du bureau", "Street name", "City/Town/Village", "Province", "Postal code", "Signature", "Permit", "Certificate", "detach here", "change of address", "lot / conc / twp"]) assert.equal((await parser.parse({ text: `NAME / NOM\n${label}` })).data.registeredOwner, undefined);
for (const [label, a, b, field] of [["YEAR / ANNEE", "2020", "2023", "year"], ["MAKE / MARQUE", "HONDA", "TESLA", "make"], ["MODEL / MODELE", "CIVIC", "MODEL 3", "model"], ["PLATE / PLAQUE", "ABCD123", "EFGH456", "plate"], ["ADDRESS / ADRESSE", "10 MAIN STREET", "20 BAY STREET", "ownerAddress"]]) assert.equal((await parser.parse({ text: `${label}\n${a}\n${label}\n${b}` })).data[field], undefined);
const expected = { registeredOwner: "DELTA, TEST", ownerAddress: "300 TEST FIXTURE ROAD, EXAMPLEVILLE ON A1A 1A1", vin: "ZZZTESTA0T0000001", year: "2023", make: "TESLA", model: "MODEL 3", plate: "CVAB123", bodyType: "4D" };
assert.deepEqual((await parser.parse({ text: clean, confidence: .95 })).data, expected);
const block = (text: string, x: number, y: number) => ({ text, boundingBox: { x, y, width: 140, height: 10 }, confidence: .97 });
const blocks = [block("NAME / NOM", 10, 10), block("DELTA, TEST", 10, 25), block("THETA, TEST", 450, 25), block("Office Use Only", 450, 10), block("Please print clearly", 450, 40), block("ADDRESS / ADRESSE", 10, 60), block("300 TEST FIXTURE ROAD", 10, 75), block("EXAMPLEVILLE ON A1A 1A1", 10, 90), block("change, detach here", 10, 105), block("PLATE / PLAQUE", 10, 130), block("CVAB123", 10, 145), block("PAS - FIT", 450, 145), block("YEAR / ANNEE", 10, 180), block("2023", 10, 195), block("MAKE / MARQUE", 200, 180), block("TESLA", 200, 195), block("MODEL / MODELE", 400, 180), block("MODEL 3", 400, 195)];
const layout = await parser.parse({ text: traps, pages: [{ page: 2, blocks }] });
for (const field of ["registeredOwner", "ownerAddress", "plate", "year", "make", "model"] as const) { assert.equal(layout.data[field], expected[field]); assert.equal(layout.fieldEvidence[field][0].page, 2); assert.ok(layout.fieldEvidence[field][0].boundingBox); assert.equal(layout.fieldEvidence[field][0].confidence, .97); }
const unknownConfidence = await parser.parse({ text: traps, pages: [{ page: 2, blocks: blocks.map(({ confidence, ...b }) => b) }] });
assert.equal(unknownConfidence.fieldEvidence.registeredOwner[0].confidence, undefined);
console.log("Ownership targeted: passed.");
