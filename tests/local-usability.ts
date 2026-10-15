import assert from "node:assert/strict";
import { DOCUMENT_UPLOAD_ACCEPT, openDocumentPicker } from "../lib/file-picker.ts";
import { validationHasStarted } from "../lib/validation-workflow.ts";

assert.equal(validationHasStarted({ validationStatus: "NOT_STARTED" }), false, "new cases must not run blocker validation");
assert.equal(validationHasStarted({ validationStatus: "IN_PROGRESS" }), true, "Start key-in must enable validation");
assert.equal(validationHasStarted({ validationStatus: "COMPLETE" }), true, "completed validation remains active");
assert.equal(validationHasStarted({}), true, "existing saved cases retain prior behavior");

let pickerClicks = 0;
openDocumentPicker({ click: () => { pickerClicks += 1; } } as Pick<HTMLInputElement, "click">);
assert.equal(pickerClicks, 1, "the Documents upload button must invoke the native file input");
for (const extension of [".pdf", ".jpg", ".jpeg", ".png", ".txt", ".json", ".csv", ".xml"]) assert.ok(DOCUMENT_UPLOAD_ACCEPT.includes(extension), `${extension} must be selectable`);

console.log("Local usability targeted: passed.");
