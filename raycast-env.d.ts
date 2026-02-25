/// <reference types="@raycast/api">

/* 🚧 🚧 🚧
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 * 🚧 🚧 🚧 */

/* eslint-disable @typescript-eslint/ban-types */

type ExtensionPreferences = {
  /** Claude Model - Which Claude model to use for code generation */
  "claudeModel": "claude-sonnet-4-6" | "claude-opus-4-6" | "claude-sonnet-4-5-20250929" | "claude-haiku-4-5-20251001"
}

/** Preferences accessible in all the extension's commands */
declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Preferences accessible in the `implement-task` command */
  export type ImplementTask = ExtensionPreferences & {}
  /** Preferences accessible in the `work-in-progress` command */
  export type WorkInProgress = ExtensionPreferences & {}
  /** Preferences accessible in the `run-orchestration` command */
  export type RunOrchestration = ExtensionPreferences & {}
  /** Preferences accessible in the `open-resources` command */
  export type OpenResources = ExtensionPreferences & {}
  /** Preferences accessible in the `prepare-qa-note` command */
  export type PrepareQaNote = ExtensionPreferences & {}
  /** Preferences accessible in the `prepare-release-note` command */
  export type PrepareReleaseNote = ExtensionPreferences & {}
}

declare namespace Arguments {
  /** Arguments passed to the `implement-task` command */
  export type ImplementTask = {}
  /** Arguments passed to the `work-in-progress` command */
  export type WorkInProgress = {}
  /** Arguments passed to the `run-orchestration` command */
  export type RunOrchestration = {}
  /** Arguments passed to the `open-resources` command */
  export type OpenResources = {}
  /** Arguments passed to the `prepare-qa-note` command */
  export type PrepareQaNote = {}
  /** Arguments passed to the `prepare-release-note` command */
  export type PrepareReleaseNote = {}
}

