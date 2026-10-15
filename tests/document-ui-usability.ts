import assert from "node:assert/strict";
import { acceptedDroppedFiles, isSupportedDocumentName } from "../lib/document-drop.ts";
import { clampDocumentPanelWidth, DOCUMENT_PANEL_DEFAULT, DOCUMENT_PANEL_MAX, DOCUMENT_PANEL_MIN } from "../lib/panel-width.ts";

for (const name of ["one.pdf", "two.JPG", "three.jpeg", "four.png", "five.txt", "six.json", "seven.csv", "eight.xml"]) assert.equal(isSupportedDocumentName(name), true, name);
assert.equal(isSupportedDocumentName("program.exe"), false);
const dropped = acceptedDroppedFiles([{ name: "one.pdf" }, { name: "two.png" }, { name: "skip.exe" }] as File[]);
assert.deepEqual(dropped.map((file) => file.name), ["one.pdf", "two.png"]);
assert.equal(clampDocumentPanelWidth(100), DOCUMENT_PANEL_MIN);
assert.equal(clampDocumentPanelWidth(500), 500);
assert.equal(clampDocumentPanelWidth(900), DOCUMENT_PANEL_MAX);
assert.ok(DOCUMENT_PANEL_DEFAULT >= DOCUMENT_PANEL_MIN && DOCUMENT_PANEL_DEFAULT <= DOCUMENT_PANEL_MAX);
console.log("Document UI usability targeted: passed.");
