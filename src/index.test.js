import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker, {
	getThreshold,
	getPreviousJackpot,
	storePreviousJackpot,
	detectThresholdCrossing,
	buildNotificationMessage,
	sendNtfyNotification,
	isNtfyConfigured,
} from './index.js';

/**
 * Test suite for LottoCheck CloudFlare Worker
 *
 * Outbound requests are mocked by stubbing the global fetch with a
 * per-origin router (the Workers Vitest pool makes globalThis.fetch
 * writable for exactly this purpose; fetchMock is no longer exported
 * from cloudflare:test in plugin-based versions). Each test registers
 * handlers for the origins it expects; unexpected origins throw.
 */

let fetchHandlers;

beforeEach(() => {
	fetchHandlers = new Map();
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input, init) => {
			const url = typeof input === 'string' ? input : input.url;
			const handler = fetchHandlers.get(new URL(url).origin);
			if (!handler) {
				throw new Error(`Unexpected fetch to ${url}`);
			}
			return handler(url, init);
		}),
	);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

/**
 * Test Fixtures - Common test data for consistent testing
 */
const fixtures = {
	megaMillions: {
		billion: { amount: 1700000000, display: '$1.70 Billion' },
		halfBillion: { amount: 500000000, display: '$500 Million' },
		twoBillion: { amount: 2000000000, display: '$2.00 Billion' },
	},
	powerball: {
		billion: '$1.50 Billion',
		halfBillion: '$450 Million',
		twoBillion: '$1.80 Billion',
	},
	dates: {
		default: '2025-12-26T00:00:00',
	},
};

/**
 * Mock helper functions to reduce duplication
 */

/**
 * Build a Mega Millions API response body
 * @param {number} jackpotAmount - Jackpot amount in dollars (e.g., 1700000000 for $1.7B)
 * @param {string} [drawingDate] - ISO date string for next drawing
 * @returns {string} JSON body matching the API's { d: "<json>" } envelope
 */
function megaMillionsBody(jackpotAmount, drawingDate = fixtures.dates.default) {
	return JSON.stringify({
		d: JSON.stringify({
			Jackpot: { NextPrizePool: jackpotAmount },
			NextDrawingDate: drawingDate,
		}),
	});
}

/**
 * Build a Powerball HTML page body
 * @param {string} jackpotText - Jackpot text to include (e.g., "$1.70 Billion")
 * @param {string} [drawingText] - Drawing date text
 * @returns {string} HTML page containing the jackpot and drawing date
 */
function powerballHtml(jackpotText, drawingText = 'Friday, December 27, 2024') {
	return `<html>Estimated Jackpot: ${jackpotText} Next Drawing: ${drawingText}</html>`;
}

/**
 * Route Mega Millions API requests to a mock response
 * @param {string} body - Response body
 * @param {number} [status=200] - Response status
 */
function mockMegaMillions(body, status = 200) {
	fetchHandlers.set('https://www.megamillions.com', () => new Response(body, { status }));
}

/**
 * Route Powerball homepage requests to a mock response
 * @param {string} html - Response body
 * @param {number} [status=200] - Response status
 */
function mockPowerball(html, status = 200) {
	fetchHandlers.set('https://www.powerball.com', () => new Response(html, { status }));
}

/**
 * Intercept both lottery requests with successful responses
 * @param {Object} [options={}] - Mock configuration
 * @param {number} [options.megaMillionsJackpot] - Mega Millions jackpot in dollars
 * @param {string} [options.powerballJackpot] - Powerball jackpot display text
 */
function mockLotteries({
	megaMillionsJackpot = fixtures.megaMillions.billion.amount,
	powerballJackpot = fixtures.powerball.billion,
} = {}) {
	mockMegaMillions(megaMillionsBody(megaMillionsJackpot));
	mockPowerball(powerballHtml(powerballJackpot));
}

/**
 * Create a mock KV namespace for testing
 * @param {Object} [initialData={}] - Initial key → stored-object entries
 * @returns {Object} Mock KV namespace with get/put methods and _storage map
 */
function createMockKV(initialData = {}) {
	const storage = new Map(Object.entries(initialData).map(([key, value]) => [key, JSON.stringify(value)]));
	return {
		get: vi.fn(async (key) => storage.get(key) || null),
		put: vi.fn(async (key, value) => {
			storage.set(key, value);
		}),
		_storage: storage,
	};
}

/**
 * Route ntfy publish requests to a mock response and record them
 * @param {number} [status=200] - Response status
 * @returns {{requests: Array<{url: string, init: Object}>}} Recorded requests
 */
function mockNtfy(status = 200, body = '{}') {
	const requests = [];
	fetchHandlers.set('https://ntfy.sh', (url, init) => {
		requests.push({ url, init });
		return new Response(body, { status });
	});
	return { requests };
}

/**
 * Create an env object for scheduled-handler tests with explicit mocks,
 * so real bindings from wrangler.toml never receive test traffic.
 * @param {Object} [overrides={}] - Properties to merge over the defaults
 * @returns {Object} Mock env
 */
function createMockEnv(overrides = {}) {
	return {
		JACKPOT_THRESHOLD_MILLIONS: '1500',
		LOTTERY_STATE: createMockKV(),
		...overrides,
	};
}

/**
 * Create a ScheduledController-shaped object for scheduled-handler tests
 * @returns {Object} Controller with scheduledTime and cron
 */
function createScheduledController() {
	return { scheduledTime: Date.now(), cron: '0 20 * * *' };
}

describe('LottoCheck Worker', () => {
	describe('fetch handler', () => {
		it('returns jackpot data for both lotteries', async () => {
			mockLotteries();

			const request = new Request('http://localhost');
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);

			expect(response.status).toBe(200);
			const data = await response.json();

			expect(data).toHaveProperty('timestamp');
			expect(data).toHaveProperty('megaMillions');
			expect(data).toHaveProperty('powerball');
			expect(data).toHaveProperty('threshold');

			expect(data.megaMillions.lottery).toBe('Mega Millions');
			expect(data.powerball.lottery).toBe('Powerball');
		});

		it('handles upstream errors gracefully', async () => {
			mockMegaMillions('Server error', 500);
			mockPowerball('Server error', 500);

			const request = new Request('http://localhost');
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);

			expect(response.status).toBe(200);
			const data = await response.json();

			// Should still return data, but with error fields
			expect(data.megaMillions).toHaveProperty('error');
			expect(data.powerball).toHaveProperty('error');
		});

		it('returns correct Content-Type header', async () => {
			mockLotteries();

			const request = new Request('http://localhost');
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);

			expect(response.headers.get('Content-Type')).toBe('application/json');
		});

		it('includes timestamp in response', async () => {
			mockLotteries();

			const request = new Request('http://localhost');
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			const data = await response.json();

			expect(data).toHaveProperty('timestamp');
			expect(typeof data.timestamp).toBe('string');
			// Verify it's a valid ISO date string
			expect(() => new Date(data.timestamp)).not.toThrow();
		});
	});

	describe('scheduled handler', () => {
		it('logs jackpot data on scheduled trigger', async () => {
			const consoleLogs = [];
			vi.spyOn(console, 'log').mockImplementation((...args) => {
				consoleLogs.push(args.join(' '));
			});

			mockLotteries();

			const controller = createScheduledController();
			const ctx = createExecutionContext();

			await worker.scheduled(controller, createMockEnv(), ctx);
			await waitOnExecutionContext(ctx);

			expect(consoleLogs.some((log) => log.includes('LottoCheck: Starting jackpot check'))).toBe(true);
			expect(consoleLogs.some((log) => log.includes('Mega Millions:'))).toBe(true);
			expect(consoleLogs.some((log) => log.includes('Powerball:'))).toBe(true);
		});

		it('logs alert when threshold is exceeded', async () => {
			const consoleLogs = [];
			vi.spyOn(console, 'log').mockImplementation((...args) => {
				consoleLogs.push(args.join(' '));
			});

			mockLotteries({
				megaMillionsJackpot: fixtures.megaMillions.twoBillion.amount,
				powerballJackpot: fixtures.powerball.twoBillion,
			});

			const controller = createScheduledController();
			const ctx = createExecutionContext();

			await worker.scheduled(controller, createMockEnv(), ctx);
			await waitOnExecutionContext(ctx);

			expect(consoleLogs.some((log) => log.includes('ALERT:'))).toBe(true);
			expect(consoleLogs.some((log) => log.includes('exceeded threshold'))).toBe(true);
		});

		it('logs threshold crossing', async () => {
			const consoleLogs = [];
			vi.spyOn(console, 'log').mockImplementation((...args) => {
				consoleLogs.push(args.join(' '));
			});

			mockLotteries({ megaMillionsJackpot: fixtures.megaMillions.twoBillion.amount });

			const mockEnv = createMockEnv({
				LOTTERY_STATE: createMockKV({
					'Mega Millions': { jackpotAmount: 1000, lastChecked: '2025-01-01' },
					Powerball: { jackpotAmount: 1000, lastChecked: '2025-01-01' },
				}),
			});

			const controller = createScheduledController();
			const ctx = createExecutionContext();

			await worker.scheduled(controller, mockEnv, ctx);
			await waitOnExecutionContext(ctx);

			expect(consoleLogs.some((log) => log.includes('THRESHOLD CROSSED: Mega Millions'))).toBe(true);
		});
	});

	describe('Integration - KV and notifications', () => {
		it('stores jackpots in KV after check', async () => {
			mockLotteries();
			const mockEnv = createMockEnv();

			const controller = createScheduledController();
			const ctx = createExecutionContext();

			await worker.scheduled(controller, mockEnv, ctx);
			await waitOnExecutionContext(ctx);

			expect(mockEnv.LOTTERY_STATE.put).toHaveBeenCalledWith('Mega Millions', expect.any(String));
			expect(mockEnv.LOTTERY_STATE.put).toHaveBeenCalledWith('Powerball', expect.any(String));
		});

		it('sends a notification on threshold crossing', async () => {
			mockMegaMillions(megaMillionsBody(fixtures.megaMillions.twoBillion.amount));
			mockPowerball(powerballHtml(fixtures.powerball.halfBillion));

			const ntfy = mockNtfy();
			const mockEnv = createMockEnv({
				LOTTERY_STATE: createMockKV({
					'Mega Millions': { jackpotAmount: 1000, lastChecked: '2025-01-01' },
					Powerball: { jackpotAmount: 1000, lastChecked: '2025-01-01' },
				}),
				NTFY_TOPIC: 'test-topic',
			});

			const controller = createScheduledController();
			const ctx = createExecutionContext();

			await worker.scheduled(controller, mockEnv, ctx);
			await waitOnExecutionContext(ctx);

			expect(ntfy.requests).toHaveLength(1);
			const { url, init } = ntfy.requests[0];
			expect(url).toBe('https://ntfy.sh/test-topic');
			expect(init.method).toBe('POST');
			expect(init.headers.Title).toContain('Mega Millions');
			expect(init.body).toContain('$2.00 Billion');

			// State is stored after a successful notification
			expect(mockEnv.LOTTERY_STATE.put).toHaveBeenCalledWith('Mega Millions', expect.any(String));
			expect(JSON.parse(mockEnv.LOTTERY_STATE._storage.get('Mega Millions')).jackpotAmount).toBe(2000);
		});

		it('does not send a notification when staying above threshold', async () => {
			mockLotteries({
				megaMillionsJackpot: fixtures.megaMillions.twoBillion.amount,
				powerballJackpot: fixtures.powerball.twoBillion,
			});

			const ntfy = mockNtfy();
			const mockEnv = createMockEnv({
				LOTTERY_STATE: createMockKV({
					'Mega Millions': { jackpotAmount: 1700, lastChecked: '2025-01-01' },
					Powerball: { jackpotAmount: 1700, lastChecked: '2025-01-01' },
				}),
				NTFY_TOPIC: 'test-topic',
			});

			const controller = createScheduledController();
			const ctx = createExecutionContext();

			await worker.scheduled(controller, mockEnv, ctx);
			await waitOnExecutionContext(ctx);

			expect(ntfy.requests).toHaveLength(0);
		});

		it('logs why no notification was sent when already above threshold', async () => {
			const consoleLogs = [];
			vi.spyOn(console, 'log').mockImplementation((...args) => {
				consoleLogs.push(args.join(' '));
			});

			mockLotteries({ megaMillionsJackpot: fixtures.megaMillions.twoBillion.amount });

			const mockEnv = createMockEnv({
				LOTTERY_STATE: createMockKV({
					'Mega Millions': { jackpotAmount: 1700, lastChecked: '2025-01-01' },
				}),
				NTFY_TOPIC: 'test-topic',
			});

			const controller = createScheduledController();
			const ctx = createExecutionContext();

			await worker.scheduled(controller, mockEnv, ctx);
			await waitOnExecutionContext(ctx);

			expect(
				consoleLogs.some(
					(log) => log.includes('Mega Millions: no notification') && log.includes('already above threshold'),
				),
			).toBe(true);
		});

		it('warns when a crossing occurs but NTFY_TOPIC is not configured', async () => {
			const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

			mockMegaMillions(megaMillionsBody(fixtures.megaMillions.twoBillion.amount));
			mockPowerball(powerballHtml(fixtures.powerball.halfBillion));

			const mockEnv = createMockEnv({
				LOTTERY_STATE: createMockKV({
					'Mega Millions': { jackpotAmount: 1000, lastChecked: '2025-01-01' },
				}),
			});

			const controller = createScheduledController();
			const ctx = createExecutionContext();

			await worker.scheduled(controller, mockEnv, ctx);
			await waitOnExecutionContext(ctx);

			expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('NTFY_TOPIC is not configured'));
		});

		it('logs why no notification was sent when still below threshold', async () => {
			const consoleLogs = [];
			vi.spyOn(console, 'log').mockImplementation((...args) => {
				consoleLogs.push(args.join(' '));
			});

			mockLotteries({ megaMillionsJackpot: fixtures.megaMillions.halfBillion.amount });

			const mockEnv = createMockEnv({
				LOTTERY_STATE: createMockKV({
					'Mega Millions': { jackpotAmount: 400, lastChecked: '2025-01-01' },
				}),
				NTFY_TOPIC: 'test-topic',
			});

			const controller = createScheduledController();
			const ctx = createExecutionContext();

			await worker.scheduled(controller, mockEnv, ctx);
			await waitOnExecutionContext(ctx);

			expect(
				consoleLogs.some(
					(log) => log.includes('Mega Millions: no notification') && log.includes('still below threshold'),
				),
			).toBe(true);
		});

		it('handles KV namespace being undefined', async () => {
			mockLotteries();
			const mockEnv = createMockEnv({ LOTTERY_STATE: undefined });

			const controller = createScheduledController();
			const ctx = createExecutionContext();

			await expect(worker.scheduled(controller, mockEnv, ctx)).resolves.not.toThrow();
			await waitOnExecutionContext(ctx);
		});

		it('keeps previous state when the notification fails so the crossing retries next run', async () => {
			mockMegaMillions(megaMillionsBody(fixtures.megaMillions.twoBillion.amount));
			mockPowerball(powerballHtml(fixtures.powerball.halfBillion));

			mockNtfy(500);
			const mockEnv = createMockEnv({
				LOTTERY_STATE: createMockKV({
					'Mega Millions': { jackpotAmount: 1000, lastChecked: '2025-01-01' },
					Powerball: { jackpotAmount: 400, lastChecked: '2025-01-01' },
				}),
				NTFY_TOPIC: 'test-topic',
			});

			const controller = createScheduledController();
			const ctx = createExecutionContext();

			await worker.scheduled(controller, mockEnv, ctx);
			await waitOnExecutionContext(ctx);

			// Mega Millions crossed but the notification failed: its state must not
			// be updated, so the crossing is detected again on the next run
			expect(mockEnv.LOTTERY_STATE.put).not.toHaveBeenCalledWith('Mega Millions', expect.any(String));
			// Powerball did not cross, so its state updates normally
			expect(mockEnv.LOTTERY_STATE.put).toHaveBeenCalledWith('Powerball', expect.any(String));
		});

		it('skips a lottery when its KV read fails so an unknown previous amount is not treated as 0', async () => {
			mockMegaMillions(megaMillionsBody(fixtures.megaMillions.twoBillion.amount));
			mockPowerball(powerballHtml(fixtures.powerball.halfBillion));

			const ntfy = mockNtfy();
			const kv = createMockKV({
				Powerball: { jackpotAmount: 400, lastChecked: '2025-01-01' },
			});
			const workingGet = kv.get.getMockImplementation();
			kv.get = vi.fn(async (key) => {
				if (key === 'Mega Millions') {
					throw new Error('KV timeout');
				}
				return workingGet(key);
			});
			const mockEnv = createMockEnv({
				LOTTERY_STATE: kv,
				NTFY_TOPIC: 'test-topic',
			});

			const controller = createScheduledController();
			const ctx = createExecutionContext();

			await worker.scheduled(controller, mockEnv, ctx);
			await waitOnExecutionContext(ctx);

			// Mega Millions is above threshold but its previous amount is unknown:
			// no alert (it may not be a fresh crossing) and no state overwrite
			expect(ntfy.requests).toHaveLength(0);
			expect(kv.put).not.toHaveBeenCalledWith('Mega Millions', expect.any(String));
			// Powerball is unaffected and updates normally
			expect(kv.put).toHaveBeenCalledWith('Powerball', expect.any(String));
		});

		it('repairs a corrupt KV value on the next successful run', async () => {
			mockLotteries();

			const kv = createMockKV();
			kv._storage.set('Mega Millions', 'not valid json {');
			const mockEnv = createMockEnv({ LOTTERY_STATE: kv });

			const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

			const controller = createScheduledController();
			const ctx = createExecutionContext();

			await worker.scheduled(controller, mockEnv, ctx);
			await waitOnExecutionContext(ctx);

			// The corrupt value must be overwritten, not skipped forever
			expect(kv.put).toHaveBeenCalledWith('Mega Millions', expect.any(String));
			expect(JSON.parse(kv._storage.get('Mega Millions')).jackpotAmount).toBe(1700);

			consoleErrorSpy.mockRestore();
		});

		it('keeps previous state when a lottery fetch fails', async () => {
			mockMegaMillions('Server error', 500);
			mockPowerball(powerballHtml(fixtures.powerball.halfBillion));

			const mockEnv = createMockEnv({
				LOTTERY_STATE: createMockKV({
					'Mega Millions': { jackpotAmount: 1700, lastChecked: '2025-01-01' },
				}),
			});

			const controller = createScheduledController();
			const ctx = createExecutionContext();

			await worker.scheduled(controller, mockEnv, ctx);
			await waitOnExecutionContext(ctx);

			// A failed fetch must not overwrite the stored amount with 0, which
			// would trigger a duplicate crossing alert on the next run
			expect(mockEnv.LOTTERY_STATE.put).not.toHaveBeenCalledWith('Mega Millions', expect.any(String));
			expect(mockEnv.LOTTERY_STATE.put).toHaveBeenCalledWith('Powerball', expect.any(String));
			expect(JSON.parse(mockEnv.LOTTERY_STATE._storage.get('Mega Millions')).jackpotAmount).toBe(1700);
		});

		it('stores jackpots on crossing when notifications are not configured', async () => {
			mockMegaMillions(megaMillionsBody(fixtures.megaMillions.twoBillion.amount));
			mockPowerball(powerballHtml(fixtures.powerball.halfBillion));

			const mockEnv = createMockEnv({
				LOTTERY_STATE: createMockKV({
					'Mega Millions': { jackpotAmount: 1000, lastChecked: '2025-01-01' },
				}),
			});

			const controller = createScheduledController();
			const ctx = createExecutionContext();

			await worker.scheduled(controller, mockEnv, ctx);
			await waitOnExecutionContext(ctx);

			expect(mockEnv.LOTTERY_STATE.put).toHaveBeenCalledWith('Mega Millions', expect.any(String));
		});
	});
});

describe('Threshold checking', () => {
	it('correctly identifies when jackpots exceed threshold', async () => {
		mockLotteries({
			megaMillionsJackpot: fixtures.megaMillions.twoBillion.amount,
			powerballJackpot: fixtures.powerball.twoBillion,
		});

		const request = new Request('http://localhost');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, { JACKPOT_THRESHOLD_MILLIONS: '1500' }, ctx);
		const data = await response.json();

		expect(data.megaMillions.exceedsThreshold).toBe(true);
		expect(data.powerball.exceedsThreshold).toBe(true);
		expect(data.threshold.exceeded).toBe(true);
		expect(data.threshold.exceedingLotteries).toContain('Mega Millions');
		expect(data.threshold.exceedingLotteries).toContain('Powerball');
	});

	it('correctly identifies when jackpots do not exceed threshold', async () => {
		mockLotteries({
			megaMillionsJackpot: fixtures.megaMillions.halfBillion.amount,
			powerballJackpot: '$400 Million',
		});

		const request = new Request('http://localhost');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, { JACKPOT_THRESHOLD_MILLIONS: '1500' }, ctx);
		const data = await response.json();

		expect(data.megaMillions.exceedsThreshold).toBe(false);
		expect(data.powerball.exceedsThreshold).toBe(false);
		expect(data.threshold.exceeded).toBe(false);
		expect(data.threshold.exceedingLotteries).toHaveLength(0);
	});

	it('uses default threshold when env var is invalid', async () => {
		mockLotteries({
			megaMillionsJackpot: 1600000000,
			powerballJackpot: '$400 Million',
		});

		const request = new Request('http://localhost');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, { JACKPOT_THRESHOLD_MILLIONS: 'invalid' }, ctx);
		const data = await response.json();

		// Default threshold is 1500, so 1600M should exceed it
		expect(data.threshold.amount).toBe(1500);
		expect(data.megaMillions.exceedsThreshold).toBe(true);
	});

	it('formats threshold display correctly for billions', async () => {
		mockLotteries({
			megaMillionsJackpot: fixtures.megaMillions.halfBillion.amount,
			powerballJackpot: '$400 Million',
		});

		const request = new Request('http://localhost');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, { JACKPOT_THRESHOLD_MILLIONS: '1500' }, ctx);
		const data = await response.json();

		expect(data.threshold.display).toBe('$1.50 Billion');
	});

	it('formats threshold display correctly for millions', async () => {
		mockLotteries({
			megaMillionsJackpot: fixtures.megaMillions.halfBillion.amount,
			powerballJackpot: '$400 Million',
		});

		const request = new Request('http://localhost');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, { JACKPOT_THRESHOLD_MILLIONS: '500' }, ctx);
		const data = await response.json();

		expect(data.threshold.display).toBe('$500 Million');
	});

	it('treats a lottery with missing data as not exceeding', async () => {
		mockMegaMillions(megaMillionsBody(fixtures.megaMillions.twoBillion.amount));
		mockPowerball('<html>No jackpot info here</html>');

		const request = new Request('http://localhost');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, { JACKPOT_THRESHOLD_MILLIONS: '1500' }, ctx);
		const data = await response.json();

		expect(data.megaMillions.exceedsThreshold).toBe(true);
		expect(data.powerball.exceedsThreshold).toBe(false);
		expect(data.threshold.exceeded).toBe(true);
		expect(data.threshold.exceedingLotteries).toEqual(['Mega Millions']);
	});

	it('handles errors without triggering threshold exceeded', async () => {
		mockMegaMillions('Server error', 500);
		mockPowerball('Server error', 500);

		const request = new Request('http://localhost');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, { JACKPOT_THRESHOLD_MILLIONS: '0' }, ctx);
		const data = await response.json();

		// Neither should exceed threshold when there are errors
		expect(data.megaMillions.exceedsThreshold).toBe(false);
		expect(data.powerball.exceedsThreshold).toBe(false);
		expect(data.threshold.exceeded).toBe(false);
		expect(data.threshold.exceedingLotteries).toHaveLength(0);
	});
});

describe('getThreshold', () => {
	it('returns threshold from env when valid', () => {
		expect(getThreshold({ JACKPOT_THRESHOLD_MILLIONS: '2000' })).toBe(2000);
	});

	it('returns default threshold when env is undefined', () => {
		expect(getThreshold(undefined)).toBe(1500);
	});

	it('returns default threshold when env is empty object', () => {
		expect(getThreshold({})).toBe(1500);
	});

	it('returns default threshold when JACKPOT_THRESHOLD_MILLIONS is missing', () => {
		expect(getThreshold({ OTHER_VAR: 'value' })).toBe(1500);
	});

	it('returns default threshold when JACKPOT_THRESHOLD_MILLIONS is not a number', () => {
		expect(getThreshold({ JACKPOT_THRESHOLD_MILLIONS: 'invalid' })).toBe(1500);
	});

	it('returns default threshold when JACKPOT_THRESHOLD_MILLIONS is empty string', () => {
		expect(getThreshold({ JACKPOT_THRESHOLD_MILLIONS: '' })).toBe(1500);
	});

	it('returns default threshold when JACKPOT_THRESHOLD_MILLIONS is zero', () => {
		expect(getThreshold({ JACKPOT_THRESHOLD_MILLIONS: '0' })).toBe(1500);
	});

	it('returns default threshold when JACKPOT_THRESHOLD_MILLIONS is negative', () => {
		expect(getThreshold({ JACKPOT_THRESHOLD_MILLIONS: '-500' })).toBe(1500);
	});

	it('handles float values correctly', () => {
		expect(getThreshold({ JACKPOT_THRESHOLD_MILLIONS: '1750.5' })).toBe(1750.5);
	});
});

describe('Mega Millions API', () => {
	it('correctly parses API response with billion jackpot', async () => {
		mockMegaMillions(megaMillionsBody(fixtures.megaMillions.billion.amount));
		mockPowerball('<html>Powerball data</html>');

		const request = new Request('http://localhost');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		const data = await response.json();

		expect(data.megaMillions.lottery).toBe('Mega Millions');
		expect(data.megaMillions.jackpot).toContain('Billion');
		expect(data.megaMillions.jackpotAmount).toBe(1700);
		expect(data.megaMillions.nextDrawing).toMatch(/\w+, \w+ \d+, \d{4}/);
	});

	it('correctly parses API response with million jackpot', async () => {
		mockMegaMillions(megaMillionsBody(fixtures.megaMillions.halfBillion.amount));
		mockPowerball('<html>Powerball data</html>');

		const request = new Request('http://localhost');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		const data = await response.json();

		expect(data.megaMillions.lottery).toBe('Mega Millions');
		expect(data.megaMillions.jackpot).toContain('Million');
		expect(data.megaMillions.jackpotAmount).toBe(500);
	});

	it('handles API errors gracefully', async () => {
		mockMegaMillions('Server error', 500);
		mockPowerball('<html>Powerball data</html>');

		const request = new Request('http://localhost');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		const data = await response.json();

		expect(data.megaMillions.lottery).toBe('Mega Millions');
		expect(data.megaMillions.jackpot).toBe('Error');
		expect(data.megaMillions.jackpotAmount).toBe(0);
		expect(data.megaMillions.error).toBeDefined();
	});

	it('handles malformed API responses gracefully', async () => {
		mockMegaMillions('not json at all');
		mockPowerball('<html>Powerball data</html>');

		const request = new Request('http://localhost');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		const data = await response.json();

		expect(data.megaMillions.jackpot).toBe('Error');
		expect(data.megaMillions.error).toBeDefined();
	});

	// A 200 with a well-formed envelope but a bad jackpot is the dangerous case:
	// without an error property, processLottery treats it as good data and writes
	// it to KV, which resets the crossing state and duplicates the next alert.
	it.each([
		['a null jackpot', JSON.stringify({ d: JSON.stringify({ Jackpot: { NextPrizePool: null } }) })],
		['a missing jackpot field', JSON.stringify({ d: JSON.stringify({ Jackpot: {} }) })],
		['a non-numeric jackpot', JSON.stringify({ d: JSON.stringify({ Jackpot: { NextPrizePool: 'lots' } }) })],
		['a zero jackpot', JSON.stringify({ d: JSON.stringify({ Jackpot: { NextPrizePool: 0 } }) })],
	])('reports an error for a Mega Millions response with %s', async (_label, body) => {
		mockMegaMillions(body);
		mockPowerball(powerballHtml(fixtures.powerball.billion));

		const request = new Request('http://localhost');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, createMockEnv(), ctx);
		const data = await response.json();

		expect(data.megaMillions.error).toBeDefined();
		expect(data.megaMillions.jackpot).toBe('Error');
		expect(data.megaMillions.jackpotAmount).toBe(0);
		expect(data.megaMillions.exceedsThreshold).toBe(false);
	});

	it.each([
		['an unparseable amount', '$, Million'],
		['a zero jackpot', '$0 Million'],
	])('reports an error for a Powerball page with %s', async (_label, jackpotText) => {
		mockMegaMillions(megaMillionsBody(fixtures.megaMillions.billion.amount));
		mockPowerball(powerballHtml(jackpotText));

		const request = new Request('http://localhost');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, createMockEnv(), ctx);
		const data = await response.json();

		expect(data.powerball.error).toBeDefined();
		expect(data.powerball.jackpotAmount).toBe(0);
		expect(data.powerball.exceedsThreshold).toBe(false);
	});

	it('does not store state for a lottery whose jackpot failed validation', async () => {
		mockMegaMillions(JSON.stringify({ d: JSON.stringify({ Jackpot: { NextPrizePool: null } }) }));
		mockPowerball(powerballHtml(fixtures.powerball.billion));
		mockNtfy();

		const kv = createMockKV({ 'Mega Millions': { jackpotAmount: 100 } });
		const env = createMockEnv({ LOTTERY_STATE: kv, NTFY_TOPIC: 'test-topic' });
		const ctx = createExecutionContext();

		await worker.scheduled(createScheduledController(), env, ctx);
		await waitOnExecutionContext(ctx);

		expect(kv.put).not.toHaveBeenCalledWith('Mega Millions', expect.anything());
	});
});

describe('Powerball scraping', () => {
	it('correctly parses HTML with billion jackpot', async () => {
		mockMegaMillions(megaMillionsBody(fixtures.megaMillions.halfBillion.amount));
		mockPowerball(powerballHtml('$1.70 Billion'));

		const request = new Request('http://localhost');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		const data = await response.json();

		expect(data.powerball.lottery).toBe('Powerball');
		expect(data.powerball.jackpot).toContain('Billion');
		expect(data.powerball.jackpotAmount).toBe(1700);
		expect(data.powerball.nextDrawing).toMatch(/\w+, \w+ \d+, \d{4}/);
	});

	it('correctly parses HTML with million jackpot', async () => {
		mockMegaMillions(megaMillionsBody(fixtures.megaMillions.halfBillion.amount));
		mockPowerball('<html>Jackpot: $450 Million Next Drawing: Wednesday, Dec 25, 2024</html>');

		const request = new Request('http://localhost');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		const data = await response.json();

		expect(data.powerball.lottery).toBe('Powerball');
		expect(data.powerball.jackpot).toContain('Million');
		expect(data.powerball.jackpotAmount).toBe(450);
	});

	it('parses the current powerball.com markup with label and amount in separate spans', async () => {
		mockMegaMillions(megaMillionsBody(fixtures.megaMillions.halfBillion.amount));
		mockPowerball(`<html>
			<span class="game-title text-uppercase bg-dark text-yellow">Estimated Jackpot</span>
			<span class="game-jackpot-number text-xxxl lh-1 text-center">$375 Million</span>
			<span class="game-jackpot-number">$170.6 Million</span>
			<div>Next Drawing<h5>Wed, Jul 1, 2026</h5></div>
		</html>`);

		const request = new Request('http://localhost');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		const data = await response.json();

		expect(data.powerball.jackpotAmount).toBe(375);
		expect(data.powerball.jackpot).toBe('$375 Million');
		expect(data.powerball.nextDrawing).toBe('Wed, Jul 1, 2026');
	});

	it('does not match unrelated dollar amounts without a jackpot label', async () => {
		mockMegaMillions(megaMillionsBody(fixtures.megaMillions.halfBillion.amount));
		// Prize-tier amounts with no jackpot label must not be reported as the jackpot
		mockPowerball('<html>Match 5 prize: win $2 Million with Power Play!</html>');

		const request = new Request('http://localhost');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		const data = await response.json();

		expect(data.powerball.jackpot).toBe('Not found');
		expect(data.powerball.jackpotAmount).toBe(0);
		expect(data.powerball.error).toBe('Failed to parse jackpot from HTML');
	});

	it('handles scraping errors gracefully', async () => {
		mockMegaMillions(megaMillionsBody(fixtures.megaMillions.halfBillion.amount));
		mockPowerball('Server error', 500);

		const request = new Request('http://localhost');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		const data = await response.json();

		expect(data.powerball.lottery).toBe('Powerball');
		expect(data.powerball.jackpot).toBe('Error');
		expect(data.powerball.jackpotAmount).toBe(0);
		expect(data.powerball.error).toBeDefined();
	});

	it('handles missing data in HTML', async () => {
		mockMegaMillions(megaMillionsBody(fixtures.megaMillions.halfBillion.amount));
		mockPowerball('<html>No jackpot data here</html>');

		const request = new Request('http://localhost');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		const data = await response.json();

		expect(data.powerball.lottery).toBe('Powerball');
		expect(data.powerball.jackpot).toBe('Not found');
		expect(data.powerball.jackpotAmount).toBe(0);
		expect(data.powerball.error).toBe('Failed to parse jackpot from HTML');
		expect(data.powerball.exceedsThreshold).toBe(false);
	});

	it('correctly parses abbreviated date format (Mon, Jan 5, 2026)', async () => {
		mockMegaMillions(megaMillionsBody(fixtures.megaMillions.halfBillion.amount));
		mockPowerball('<html>Next Drawing<h5>Mon, Jan 5, 2026</h5>Estimated Jackpot $86 Million</html>');

		const request = new Request('http://localhost');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		const data = await response.json();

		expect(data.powerball.lottery).toBe('Powerball');
		expect(data.powerball.jackpot).toContain('Million');
		expect(data.powerball.jackpotAmount).toBe(86);
		expect(data.powerball.nextDrawing).toBe('Mon, Jan 5, 2026');
	});

	it('correctly parses abbreviated date with Next Drawing header', async () => {
		mockMegaMillions(megaMillionsBody(fixtures.megaMillions.halfBillion.amount));
		mockPowerball('<html>Next Drawing<h5>Wed, Dec 11, 2024</h5>Estimated Jackpot: $150 Million</html>');

		const request = new Request('http://localhost');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		const data = await response.json();

		expect(data.powerball.nextDrawing).toBe('Wed, Dec 11, 2024');
		expect(data.powerball.jackpotAmount).toBe(150);
	});

	it('handles both abbreviated and full date formats', async () => {
		mockMegaMillions(megaMillionsBody(fixtures.megaMillions.halfBillion.amount));
		mockPowerball('<html>Estimated Jackpot: $200 Million Next Drawing: Saturday, March 15, 2025</html>');

		const request = new Request('http://localhost');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		const data = await response.json();

		expect(data.powerball.nextDrawing).toBe('Saturday, March 15, 2025');
		expect(data.powerball.jackpotAmount).toBe(200);
	});
});

describe('KV Storage', () => {
	describe('getPreviousJackpot', () => {
		it('returns 0 when key does not exist', async () => {
			const mockKV = createMockKV();

			const result = await getPreviousJackpot(mockKV, 'Mega Millions');

			expect(result).toBe(0);
			expect(mockKV.get).toHaveBeenCalledWith('Mega Millions');
		});

		it('returns stored value when key exists', async () => {
			const mockKV = createMockKV({
				'Mega Millions': { jackpotAmount: 1500, lastChecked: '2025-12-25T20:00:00.000Z' },
			});

			const result = await getPreviousJackpot(mockKV, 'Mega Millions');

			expect(result).toBe(1500);
		});

		it('returns 0 when stored JSON is malformed so the next run repairs it', async () => {
			// A corrupt value is permanent — unlike a transient read failure,
			// returning null would skip the store forever and disable the lottery
			const mockKV = createMockKV();
			mockKV._storage.set('Powerball', 'not valid json {');

			const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

			const result = await getPreviousJackpot(mockKV, 'Powerball');

			expect(result).toBe(0);
			expect(consoleErrorSpy).toHaveBeenCalled();

			consoleErrorSpy.mockRestore();
		});

		it('returns 0 when stored jackpotAmount is not a number', async () => {
			const mockKV = createMockKV({
				Powerball: { jackpotAmount: '1500', lastChecked: '2025-12-25T20:00:00.000Z' },
			});

			const result = await getPreviousJackpot(mockKV, 'Powerball');

			expect(result).toBe(0);
		});

		it('returns null when the KV read fails', async () => {
			const mockKV = createMockKV();
			mockKV.get = vi.fn().mockRejectedValue(new Error('KV timeout'));

			const result = await getPreviousJackpot(mockKV, 'Mega Millions');

			expect(result).toBeNull();
		});

		it('handles undefined KV namespace gracefully and warns about it', async () => {
			const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

			const result = await getPreviousJackpot(undefined, 'Mega Millions');

			expect(result).toBe(0);
			expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('No KV binding'));

			consoleWarnSpy.mockRestore();
		});

		it('handles missing jackpotAmount field', async () => {
			const mockKV = createMockKV({
				Powerball: { lastChecked: '2025-12-25T20:00:00.000Z' },
			});

			const result = await getPreviousJackpot(mockKV, 'Powerball');

			expect(result).toBe(0);
		});
	});

	describe('storePreviousJackpot', () => {
		it('writes correct format to KV', async () => {
			const mockKV = createMockKV();

			await storePreviousJackpot(mockKV, 'Mega Millions', 1700);

			expect(mockKV.put).toHaveBeenCalledWith('Mega Millions', expect.any(String));

			const data = JSON.parse(mockKV._storage.get('Mega Millions'));
			expect(data.jackpotAmount).toBe(1700);
			expect(data).toHaveProperty('lastChecked');
		});

		it('includes timestamp in stored data', async () => {
			const mockKV = createMockKV();

			const beforeTime = new Date().toISOString();
			await storePreviousJackpot(mockKV, 'Powerball', 1500);
			const afterTime = new Date().toISOString();

			const data = JSON.parse(mockKV._storage.get('Powerball'));

			expect(() => new Date(data.lastChecked)).not.toThrow();
			expect(data.lastChecked >= beforeTime).toBe(true);
			expect(data.lastChecked <= afterTime).toBe(true);
		});

		it('handles undefined KV namespace gracefully', async () => {
			await expect(storePreviousJackpot(undefined, 'Mega Millions', 1700)).resolves.toBeUndefined();
		});

		it('handles KV put errors gracefully', async () => {
			const mockKV = {
				put: vi.fn().mockRejectedValue(new Error('KV write failed')),
			};

			const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

			await expect(storePreviousJackpot(mockKV, 'Powerball', 1500)).resolves.toBeUndefined();

			expect(consoleErrorSpy).toHaveBeenCalled();

			consoleErrorSpy.mockRestore();
		});
	});
});

describe('detectThresholdCrossing', () => {
	it('detects crossing from below to above threshold', () => {
		const result = detectThresholdCrossing(1000, 1600, 1500);

		expect(result.crossed).toBe(true);
		expect(result.previousAmount).toBe(1000);
		expect(result.currentAmount).toBe(1600);
		expect(result.threshold).toBe(1500);
	});

	it('detects crossing when current amount equals threshold', () => {
		const result = detectThresholdCrossing(1000, 1500, 1500);

		expect(result.crossed).toBe(true);
	});

	it('does not detect crossing when staying above threshold', () => {
		const result = detectThresholdCrossing(1600, 1800, 1500);

		expect(result.crossed).toBe(false);
	});

	it('does not detect crossing when staying below threshold', () => {
		const result = detectThresholdCrossing(1000, 1200, 1500);

		expect(result.crossed).toBe(false);
	});

	it('does not detect crossing when going from above to below threshold', () => {
		// This prevents notifications on downward movements
		const result = detectThresholdCrossing(1800, 1200, 1500);

		expect(result.crossed).toBe(false);
	});

	it('handles zero previous amount crossing threshold', () => {
		const result = detectThresholdCrossing(0, 1600, 1500);

		expect(result.crossed).toBe(true);
	});

	it('does not detect crossing when both amounts are zero', () => {
		const result = detectThresholdCrossing(0, 0, 1500);

		expect(result.crossed).toBe(false);
	});

	it('handles very large jackpot amounts', () => {
		const result = detectThresholdCrossing(2500, 3000, 2800);

		expect(result.crossed).toBe(true);
	});
});

describe('buildNotificationMessage', () => {
	it('includes all notification details as plain text', () => {
		const text = buildNotificationMessage('Mega Millions', 1000, 1700, 1500, 'Fri, Dec 26, 2025');

		expect(text).toContain('Mega Millions has crossed your threshold!');
		expect(text).toContain('Previous: $1.00 Billion');
		expect(text).toContain('Current: $1.70 Billion');
		expect(text).toContain('Your threshold: $1.50 Billion');
		expect(text).toContain('Next drawing: Fri, Dec 26, 2025');
	});

	it('formats amounts in millions correctly', () => {
		const text = buildNotificationMessage('Mega Millions', 450, 650, 500, 'Fri, Dec 26, 2025');

		expect(text).toContain('$450 Million');
		expect(text).toContain('$650 Million');
		expect(text).toContain('$500 Million');
	});

	it('formats amounts in billions correctly', () => {
		const text = buildNotificationMessage('Powerball', 1500, 2000, 1800, 'Sat, Dec 27, 2025');

		expect(text).toContain('$1.50 Billion');
		expect(text).toContain('$2.00 Billion');
		expect(text).toContain('$1.80 Billion');
	});

	it('contains no HTML markup', () => {
		const text = buildNotificationMessage('Powerball', 450, 650, 500, 'Sat, Dec 27, 2025');

		expect(text).not.toContain('<');
		expect(text).not.toContain('>');
	});
});

describe('sendNtfyNotification', () => {
	it('publishes to the topic and reports success', async () => {
		const ntfy = mockNtfy();

		const result = await sendNtfyNotification('my-topic', 'Test Title', 'Test message');

		expect(result.success).toBe(true);
		expect(result.error).toBeUndefined();
		expect(ntfy.requests).toHaveLength(1);
	});

	it('sends the correct request structure', async () => {
		const ntfy = mockNtfy();

		await sendNtfyNotification('my-topic', 'Jackpot Alert', 'Message body');

		const { url, init } = ntfy.requests[0];
		expect(url).toBe('https://ntfy.sh/my-topic');
		expect(init.method).toBe('POST');
		expect(init.headers).toEqual({ Title: 'Jackpot Alert', Priority: 'high', Tags: 'slot_machine' });
		expect(init.body).toBe('Message body');
	});

	it('URL-encodes the topic name', async () => {
		const ntfy = mockNtfy();

		await sendNtfyNotification('topic/with spaces', 'Title', 'Message');

		expect(ntfy.requests[0].url).toBe('https://ntfy.sh/topic%2Fwith%20spaces');
	});

	it('returns error details when ntfy responds with an error status', async () => {
		mockNtfy(500, '{"error": "limit exceeded"}');

		const result = await sendNtfyNotification('my-topic', 'Title', 'Message');

		expect(result.success).toBe(false);
		expect(result.error).toContain('ntfy send failed');
		expect(result.error).toContain('500');
		expect(result.error).toContain('limit exceeded');
	});

	it('handles fetch rejecting', async () => {
		fetchHandlers.set('https://ntfy.sh', () => {
			throw new Error('Network timeout');
		});

		const result = await sendNtfyNotification('my-topic', 'Title', 'Message');

		expect(result.success).toBe(false);
		expect(result.error).toContain('ntfy send failed');
		expect(result.error).toContain('Network timeout');
	});
});

describe('isNtfyConfigured', () => {
	it('returns true when NTFY_TOPIC is set', () => {
		expect(isNtfyConfigured({ NTFY_TOPIC: 'my-topic' })).toBe(true);
	});

	it('returns false when NTFY_TOPIC is missing', () => {
		expect(isNtfyConfigured({})).toBe(false);
	});

	it('returns false when NTFY_TOPIC is empty string', () => {
		expect(isNtfyConfigured({ NTFY_TOPIC: '' })).toBe(false);
	});

	it('returns false when env is undefined', () => {
		expect(isNtfyConfigured(undefined)).toBe(false);
	});

	it('returns false when env is null', () => {
		expect(isNtfyConfigured(null)).toBe(false);
	});
});

describe('failure alerting', () => {
	// The app's whole purpose is not missing a large jackpot, so "the Powerball
	// markup changed three months ago and nobody noticed" is the most likely way
	// it quietly stops working. A failed check has to be visible somewhere other
	// than the logs.
	it('sends a low-priority alert when a lottery check fails', async () => {
		mockMegaMillions(megaMillionsBody(fixtures.megaMillions.halfBillion.amount));
		mockPowerball('<html>redesigned page with no jackpot</html>');
		const ntfy = mockNtfy();

		const env = createMockEnv({ NTFY_TOPIC: 'test-topic' });
		const ctx = createExecutionContext();

		await worker.scheduled(createScheduledController(), env, ctx);
		await waitOnExecutionContext(ctx);

		expect(ntfy.requests).toHaveLength(1);
		expect(ntfy.requests[0].init.headers.Title).toContain('Powerball');
		expect(ntfy.requests[0].init.headers.Priority).toBe('low');
		expect(ntfy.requests[0].init.body).toContain('Failed to parse jackpot');
	});

	it('sends at most one failure alert per lottery per day', async () => {
		const ntfy = mockNtfy();
		const env = createMockEnv({ NTFY_TOPIC: 'test-topic' });

		for (let run = 0; run < 3; run++) {
			mockMegaMillions(megaMillionsBody(fixtures.megaMillions.halfBillion.amount));
			mockPowerball('<html>redesigned page with no jackpot</html>');
			const ctx = createExecutionContext();
			await worker.scheduled(createScheduledController(), env, ctx);
			await waitOnExecutionContext(ctx);
		}

		expect(ntfy.requests).toHaveLength(1);
	});

	it('alerts separately for each failing lottery', async () => {
		mockMegaMillions('not json at all');
		mockPowerball('<html>redesigned page with no jackpot</html>');
		const ntfy = mockNtfy();

		const env = createMockEnv({ NTFY_TOPIC: 'test-topic' });
		const ctx = createExecutionContext();

		await worker.scheduled(createScheduledController(), env, ctx);
		await waitOnExecutionContext(ctx);

		const titles = ntfy.requests.map((r) => r.init.headers.Title);
		expect(titles).toHaveLength(2);
		expect(titles.some((t) => t.includes('Mega Millions'))).toBe(true);
		expect(titles.some((t) => t.includes('Powerball'))).toBe(true);
	});

	it('does not touch the lottery state when a check fails', async () => {
		mockMegaMillions(megaMillionsBody(fixtures.megaMillions.halfBillion.amount));
		mockPowerball('<html>redesigned page with no jackpot</html>');
		mockNtfy();

		const kv = createMockKV({ Powerball: { jackpotAmount: 900 } });
		const env = createMockEnv({ LOTTERY_STATE: kv, NTFY_TOPIC: 'test-topic' });
		const ctx = createExecutionContext();

		await worker.scheduled(createScheduledController(), env, ctx);
		await waitOnExecutionContext(ctx);

		expect(kv.put).not.toHaveBeenCalledWith('Powerball', expect.anything());
		expect(JSON.parse(kv._storage.get('Powerball')).jackpotAmount).toBe(900);
	});

	it('does not attempt an alert when ntfy is not configured', async () => {
		mockMegaMillions(megaMillionsBody(fixtures.megaMillions.halfBillion.amount));
		mockPowerball('<html>redesigned page with no jackpot</html>');
		const ntfy = mockNtfy();

		const ctx = createExecutionContext();
		await worker.scheduled(createScheduledController(), createMockEnv(), ctx);
		await waitOnExecutionContext(ctx);

		expect(ntfy.requests).toHaveLength(0);
	});
});
