/**
 * WxO Toolkit — Credentials context (set in activate, used by services/panels).
 * Avoids passing ExtensionContext through many layers.
 */

import { WxOCredentialsService } from './WxOCredentialsService.js';

let _credentialsService: WxOCredentialsService | undefined;

export function setCredentialsService(service: WxOCredentialsService): void {
    _credentialsService = service;
}

export function getCredentialsService(): WxOCredentialsService | undefined {
    return _credentialsService;
}
