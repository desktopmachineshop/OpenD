import { installFrame } from './frame.js';
import { installWidget } from './widget.js';

export * from './protocol.js';
export type { OpenDHelpApi } from './widget.js';
export { installFrame, installWidget };

/** The host-page widget as a standalone script, served at `/embed/opend-help.js`. */
export function widgetScript(): string {
  return `/* OpenD embedded help */\n"use strict";\n(${installWidget.toString()})(window);\n`;
}

/** The in-frame script, served at `/embed/frame.js`. */
export function frameScript(): string {
  return `"use strict";\n(${installFrame.toString()})(window);\n`;
}
