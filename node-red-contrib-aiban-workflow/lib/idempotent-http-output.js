"use strict";

const http = require("node:http");
const https = require("node:https");
const { URL } = require("node:url");
const { normalizeTerminalResultMessage } = require("./result-message");

function defaultTransport({ url, headers, body, timeoutMs }) {
    return new Promise((resolve, reject) => {
        const target = new URL(url);
        const client = target.protocol === "https:" ? https : http;
        const request = client.request({
            protocol: target.protocol,
            hostname: target.hostname,
            port: target.port || undefined,
            method: "POST",
            path: target.pathname + target.search,
            headers: {
                "content-type": "application/json; charset=utf-8",
                "content-length": Buffer.byteLength(body),
                ...headers,
            },
            timeout: timeoutMs,
        }, response => {
            const chunks = [];
            response.on("data", chunk => chunks.push(chunk));
            response.on("end", () => {
                const responseBody = Buffer.concat(chunks).toString("utf8");
                if (response.statusCode >= 200 && response.statusCode < 300) {
                    resolve({ statusCode: response.statusCode, body: responseBody });
                } else {
                    reject(new Error(`HTTP ${response.statusCode}: ${responseBody.slice(0, 500)}`));
                }
            });
        });
        request.on("timeout", () => request.destroy(new Error("HTTP output timeout")));
        request.on("error", reject);
        request.end(body);
    });
}

class IdempotentHttpOutput {
    constructor(options) {
        if (!options || !options.url) throw new Error("HTTP output url is required");
        if (!options.ledger) throw new Error("HTTP output ledger is required");
        this.url = options.url;
        this.channel = options.channel || `api:${this.url}`;
        this.ledger = options.ledger;
        this.timeoutMs = Math.max(100, Number(options.timeoutMs) || 5000);
        this.maxAttempts = Math.max(1, Number(options.maxAttempts) || 3);
        this.retryDelayMs = Math.max(1, Number(options.retryDelayMs) || 250);
        this.headers = { ...(options.headers || {}) };
        this.transport = options.transport || defaultTransport;
        this._inflight = new Map();
    }

    async deliver(msg) {
        const normalized = normalizeTerminalResultMessage(msg);
        if (!normalized.terminal) return { status: "ignored", reason: "not_terminal" };
        const resultEventId = normalized.resultEventId;
        if (this._inflight.has(resultEventId)) {
            return { status: "duplicate", in_flight: true, result_event_id: resultEventId };
        }
        const reservation = this.ledger.begin(this.channel, resultEventId);
        if (!reservation.accepted) {
            return {
                status: "duplicate",
                delivered: Boolean(reservation.duplicate),
                in_flight: Boolean(reservation.in_flight),
                result_event_id: resultEventId,
            };
        }

        const promise = this._deliverReserved(normalized, reservation.attempts);
        this._inflight.set(resultEventId, promise);
        try {
            return await promise;
        } finally {
            this._inflight.delete(resultEventId);
        }
    }

    async _deliverReserved(normalized, priorAttempts) {
        const resultEventId = normalized.resultEventId;
        const body = JSON.stringify({
            result: normalized.workflowResult,
            outcome: normalized.workflowOutcome,
            abc_result: normalized.abcResult,
        });
        let lastError = null;
        for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
            try {
                const response = await this.transport({
                    url: this.url,
                    headers: {
                        ...this.headers,
                        "idempotency-key": resultEventId,
                        "x-aiban-result-event-id": resultEventId,
                    },
                    body,
                    timeoutMs: this.timeoutMs,
                });
                this.ledger.delivered(this.channel, resultEventId);
                return {
                    status: "delivered",
                    result_event_id: resultEventId,
                    attempts: priorAttempts + attempt - 1,
                    http_status: response.statusCode,
                };
            } catch (error) {
                lastError = error;
                if (attempt < this.maxAttempts) {
                    await new Promise(resolve => setTimeout(
                        resolve,
                        this.retryDelayMs * Math.pow(2, attempt - 1)
                    ));
                }
            }
        }
        this.ledger.failed(this.channel, resultEventId, lastError && lastError.message);
        return {
            status: "failed",
            result_event_id: resultEventId,
            attempts: priorAttempts + this.maxAttempts - 1,
            error: lastError ? lastError.message : "delivery failed",
        };
    }
}

module.exports = { IdempotentHttpOutput, defaultTransport };
