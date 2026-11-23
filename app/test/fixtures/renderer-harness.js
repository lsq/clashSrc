"use strict";

const path = require("node:path");

const rendererPath = path.resolve(__dirname, "../../main/src/electron/renderer.js");

function rendererLanguage() {
    return require("../../main/src/electron/core/i18n/language").createTranslator;
}

module.exports = { rendererPath, rendererLanguage };
