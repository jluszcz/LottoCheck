import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker from './index.js';

/**
 * Test suite for LottoCheck CloudFlare Worker
 */

// Store original functions to restore after each test
let originalFetch;
let originalConsoleLog;

beforeEach(() => {
	// Save originals before each test
	originalFetch = global.fetch;
	originalConsoleLog = console.log;
});

afterEach(() => {
	// Restore originals after each test
	global.fetch = originalFetch;
	console.log = originalConsoleLog;
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
		christmas: '2024-12-25T00:00:00',
		newYear: '2025-01-01T00:00:00',
	},
	thresholds: {
		low: 500,
		default: 1500,
		high: 2000,
	}
};

/**
 * Mock helper functions to reduce duplication
 */

/**
 * Create a mock Mega Millions API response
 * @param {number} jackpotAmount - Jackpot amount in dollars (e.g., 1700000000 for $1.7B)
 * @param {string} [drawingDate='2025-12-26T00:00:00'] - ISO date string for next drawing
 * @returns {Promise<Object>} Mock fetch response with Mega Millions data
 * @example
 * mockMegaMillionsResponse(fixtures.megaMillions.billion.amount)
 */
function mockMegaMillionsResponse(jackpotAmount, drawingDate = fixtures.dates.default) {
	return Promise.resolve({
		json: () => Promise.resolve({
			d: JSON.stringify({
				Jackpot: { NextPrizePool: jackpotAmount },
				NextDrawingDate: drawingDate
			})
		})
	});
}

/**
 * Create a mock Powerball HTML response
 * @param {string} jackpotText - Jackpot text to include in HTML (e.g., "$1.70 Billion")
 * @param {string} [drawingText='Friday, December 27, 2024'] - Drawing date text
 * @returns {Promise<Object>} Mock fetch response with Powerball HTML
 * @example
 * mockPowerballResponse(fixtures.powerball.billion)
 */
function mockPowerballResponse(jackpotText, drawingText = 'Friday, December 27, 2024') {
	const html = `<html>Estimated Jackpot: ${jackpotText} Next Drawing: ${drawingText}</html>`;
	return Promise.resolve({
		text: () => Promise.resolve(html)
	});
}

/**
 * Create a mock Powerball HTML response with no jackpot data
 * @returns {Promise<Object>} Mock fetch response with empty Powerball HTML
 * @example
 * mockPowerballEmptyResponse()
 */
function mockPowerballEmptyResponse() {
	return Promise.resolve({
		text: () => Promise.resolve('<html>No jackpot data here</html>')
	});
}

/**
 * Setup mock fetch with both lottery responses
 * @param {Object} [options={}] - Mock configuration
 * @param {number} [options.megaMillionsJackpot=1700000000] - Mega Millions jackpot in dollars
 * @param {string} [options.powerballJackpot='$1.50 Billion'] - Powerball jackpot display text
 * @returns {Function} Mock fetch function for verification
 * @example
 * setupMockFetch() // Uses defaults
 * setupMockFetch({
 *   megaMillionsJackpot: fixtures.megaMillions.twoBillion.amount,
 *   powerballJackpot: fixtures.powerball.twoBillion
 * })
 */
function setupMockFetch({
	megaMillionsJackpot = fixtures.megaMillions.billion.amount,
	powerballJackpot = fixtures.powerball.billion
} = {}) {
	const mockFetch = vi.fn();
	mockFetch.mockImplementationOnce(() => mockMegaMillionsResponse(megaMillionsJackpot));
	mockFetch.mockImplementationOnce(() => mockPowerballResponse(powerballJackpot));
	global.fetch = mockFetch;
	return mockFetch;
}

describe('LottoCheck Worker', () => {
	describe('fetch handler', () => {
		it('returns jackpot data for both lotteries', async () => {
			setupMockFetch();

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

		it('handles errors gracefully', async () => {
			// Mock fetch to throw an error
			global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

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
			setupMockFetch();

			const request = new Request('http://localhost');
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);

			expect(response.headers.get('Content-Type')).toBe('application/json');
		});

		it('includes timestamp in response', async () => {
			setupMockFetch();

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
			// Mock console.log to verify logging
			const consoleLogs = [];
			console.log = vi.fn((...args) => {
				consoleLogs.push(args.join(' '));
			});

			// Mock fetch for external API calls
			const mockFetch = vi.fn();
			mockFetch.mockImplementationOnce(() =>
				Promise.resolve({
					json: () => Promise.resolve({
						d: JSON.stringify({
							Jackpot: { NextPrizePool: 1700000000 },
							NextDrawingDate: '2025-12-26T00:00:00'
						})
					})
				})
			);
			mockFetch.mockImplementationOnce(() =>
				Promise.resolve({
					text: () => Promise.resolve(
						'<html>Estimated Jackpot: $1.50 Billion Next Drawing: Friday, December 27, 2024</html>'
					)
				})
			);
			global.fetch = mockFetch;

			const controller = { scheduledTime: Date.now(), cron: '0 20 * * *' };
			const ctx = createExecutionContext();

			await worker.scheduled(controller, env, ctx);

			// Verify logging occurred
			expect(consoleLogs.some(log => log.includes('LottoCheck: Starting jackpot check'))).toBe(true);
			expect(consoleLogs.some(log => log.includes('Mega Millions:'))).toBe(true);
			expect(consoleLogs.some(log => log.includes('Powerball:'))).toBe(true);
		});

		it('logs alert when threshold is exceeded', async () => {
			const consoleLogs = [];
			console.log = vi.fn((...args) => {
				consoleLogs.push(args.join(' '));
			});

			// Mock fetch with jackpots that exceed threshold
			const mockFetch = vi.fn();
			mockFetch.mockImplementationOnce(() =>
				Promise.resolve({
					json: () => Promise.resolve({
						d: JSON.stringify({
							Jackpot: { NextPrizePool: 2000000000 }, // $2B
							NextDrawingDate: '2025-12-26T00:00:00'
						})
					})
				})
			);
			mockFetch.mockImplementationOnce(() =>
				Promise.resolve({
					text: () => Promise.resolve(
						'<html>Estimated Jackpot: $1.80 Billion Next Drawing: Friday, December 27, 2024</html>'
					)
				})
			);
			global.fetch = mockFetch;

			const controller = { scheduledTime: Date.now(), cron: '0 20 * * *' };
			const ctx = createExecutionContext();

			await worker.scheduled(controller, { JACKPOT_THRESHOLD: '1500' }, ctx);

			// Verify alert was logged
			expect(consoleLogs.some(log => log.includes('ALERT:'))).toBe(true);
			expect(consoleLogs.some(log => log.includes('exceeded threshold'))).toBe(true);
		});

	describe('Integration - KV and Email', () => {
		it('stores jackpots in KV after check', async () => {
			const mockFetch = setupMockFetch();
			const mockKV = {
				get: vi.fn().mockResolvedValue(null),
				put: vi.fn().mockResolvedValue(undefined)
			};
			const mockEnv = {
				...env,
				LOTTERY_STATE: mockKV,
				JACKPOT_THRESHOLD: '1500'
			};

			const controller = {};
			const ctx = createExecutionContext();

			await worker.scheduled(controller, mockEnv, ctx);
			await waitOnExecutionContext(ctx);

			expect(mockKV.put).toHaveBeenCalledWith('Mega Millions', expect.any(String));
			expect(mockKV.put).toHaveBeenCalledWith('Powerball', expect.any(String));
		});

		it('sends email on threshold crossing', async () => {
			const mockFetch = vi.fn();
			mockFetch.mockImplementationOnce(() => mockMegaMillionsResponse(fixtures.megaMillions.twoBillion.amount));
			mockFetch.mockImplementationOnce(() => mockPowerballResponse(fixtures.powerball.halfBillion));
			mockFetch.mockImplementationOnce(() => Promise.resolve({ ok: true, status: 200 }));
			global.fetch = mockFetch;

			const mockKV = {
				get: vi.fn().mockResolvedValue(JSON.stringify({ jackpotAmount: 1000, lastChecked: '2025-01-01' })),
				put: vi.fn().mockResolvedValue(undefined)
			};
			const mockEnv = {
				...env,
				LOTTERY_STATE: mockKV,
				JACKPOT_THRESHOLD: '1500',
				FROM_EMAIL: 'from@test.com',
				TO_EMAIL: 'to@test.com'
			};

			const controller = {};
			const ctx = createExecutionContext();

			await worker.scheduled(controller, mockEnv, ctx);
			await waitOnExecutionContext(ctx);

			const mailChannelsCalls = mockFetch.mock.calls.filter(
				call => call[0] === 'https://api.mailchannels.net/tx/v1/send'
			);
			expect(mailChannelsCalls.length).toBe(1);
		});

		it('does not send email when staying above threshold', async () => {
			const mockFetch = setupMockFetch({
				megaMillionsJackpot: fixtures.megaMillions.twoBillion.amount,
				powerballJackpot: fixtures.powerball.twoBillion
			});

			const mockKV = {
				get: vi.fn().mockResolvedValue(JSON.stringify({ jackpotAmount: 1700, lastChecked: '2025-01-01' })),
				put: vi.fn().mockResolvedValue(undefined)
			};
			const mockEnv = {
				...env,
				LOTTERY_STATE: mockKV,
				JACKPOT_THRESHOLD: '1500',
				FROM_EMAIL: 'from@test.com',
				TO_EMAIL: 'to@test.com'
			};

			const controller = {};
			const ctx = createExecutionContext();

			await worker.scheduled(controller, mockEnv, ctx);
			await waitOnExecutionContext(ctx);

			expect(mockFetch.mock.calls.length).toBe(2);
		});

		it('handles KV namespace being undefined', async () => {
			const mockFetch = setupMockFetch();
			const mockEnv = {
				...env,
				LOTTERY_STATE: undefined,
				JACKPOT_THRESHOLD: '1500'
			};

			const controller = {};
			const ctx = createExecutionContext();

			await expect(
				worker.scheduled(controller, mockEnv, ctx)
			).resolves.not.toThrow();
			await waitOnExecutionContext(ctx);
		});

		it('stores jackpots even if email fails', async () => {
			const mockFetch = vi.fn();
			mockFetch.mockImplementationOnce(() => mockMegaMillionsResponse(fixtures.megaMillions.twoBillion.amount));
			mockFetch.mockImplementationOnce(() => mockPowerballResponse(fixtures.powerball.halfBillion));
			mockFetch.mockImplementationOnce(() => Promise.resolve({ ok: false, status: 500, statusText: 'Error', text: () => Promise.resolve('') }));
			global.fetch = mockFetch;

			const mockKV = {
				get: vi.fn().mockResolvedValue(JSON.stringify({ jackpotAmount: 1000, lastChecked: '2025-01-01' })),
				put: vi.fn().mockResolvedValue(undefined)
			};
			const mockEnv = {
				...env,
				LOTTERY_STATE: mockKV,
				JACKPOT_THRESHOLD: '1500',
				FROM_EMAIL: 'from@test.com',
				TO_EMAIL: 'to@test.com'
			};

			const controller = {};
			const ctx = createExecutionContext();

			await worker.scheduled(controller, mockEnv, ctx);
			await waitOnExecutionContext(ctx);

			expect(mockKV.put).toHaveBeenCalledWith('Mega Millions', expect.any(String));
			expect(mockKV.put).toHaveBeenCalledWith('Powerball', expect.any(String));
		});
	});
	});
});

describe('Threshold checking', () => {
	it('correctly identifies when jackpots exceed threshold', async () => {
		const mockFetch = vi.fn();

		// Mock both APIs with high jackpots
		mockFetch.mockImplementationOnce(() =>
			Promise.resolve({
				json: () => Promise.resolve({
					d: JSON.stringify({
						Jackpot: { NextPrizePool: 2000000000 }, // $2B
						NextDrawingDate: '2025-12-26T00:00:00'
					})
				})
			})
		);
		mockFetch.mockImplementationOnce(() =>
			Promise.resolve({
				text: () => Promise.resolve(
					'<html>Estimated Jackpot: $1.80 Billion Next Drawing: Friday, December 27, 2024</html>'
				)
			})
		);
		global.fetch = mockFetch;

		const request = new Request('http://localhost');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, { JACKPOT_THRESHOLD: '1500' }, ctx);
		const data = await response.json();

		expect(data.megaMillions.exceedsThreshold).toBe(true);
		expect(data.powerball.exceedsThreshold).toBe(true);
		expect(data.threshold.exceeded).toBe(true);
		expect(data.threshold.exceedingLotteries).toContain('Mega Millions');
		expect(data.threshold.exceedingLotteries).toContain('Powerball');
	});

	it('correctly identifies when jackpots do not exceed threshold', async () => {
		const mockFetch = vi.fn();

		// Mock both APIs with low jackpots
		mockFetch.mockImplementationOnce(() =>
			Promise.resolve({
				json: () => Promise.resolve({
					d: JSON.stringify({
						Jackpot: { NextPrizePool: 500000000 }, // $500M
						NextDrawingDate: '2025-12-26T00:00:00'
					})
				})
			})
		);
		mockFetch.mockImplementationOnce(() =>
			Promise.resolve({
				text: () => Promise.resolve(
					'<html>Estimated Jackpot: $400 Million Next Drawing: Friday, December 27, 2024</html>'
				)
			})
		);
		global.fetch = mockFetch;

		const request = new Request('http://localhost');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, { JACKPOT_THRESHOLD: '1500' }, ctx);
		const data = await response.json();

		expect(data.megaMillions.exceedsThreshold).toBe(false);
		expect(data.powerball.exceedsThreshold).toBe(false);
		expect(data.threshold.exceeded).toBe(false);
		expect(data.threshold.exceedingLotteries).toHaveLength(0);
	});

	it('uses default threshold when env var is invalid', async () => {
		const mockFetch = vi.fn();

		mockFetch.mockImplementationOnce(() =>
			Promise.resolve({
				json: () => Promise.resolve({
					d: JSON.stringify({
						Jackpot: { NextPrizePool: 1600000000 },
						NextDrawingDate: '2025-12-26T00:00:00'
					})
				})
			})
		);
		mockFetch.mockImplementationOnce(() =>
			Promise.resolve({
				text: () => Promise.resolve(
					'<html>Estimated Jackpot: $400 Million Next Drawing: Friday, December 27, 2024</html>'
				)
			})
		);
		global.fetch = mockFetch;

		const request = new Request('http://localhost');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, { JACKPOT_THRESHOLD: 'invalid' }, ctx);
		const data = await response.json();

		// Default threshold is 1500, so 1600M should exceed it
		expect(data.threshold.amount).toBe(1500);
		expect(data.megaMillions.exceedsThreshold).toBe(true);
	});

	it('formats threshold display correctly for billions', async () => {
		const mockFetch = vi.fn();

		mockFetch.mockImplementationOnce(() =>
			Promise.resolve({
				json: () => Promise.resolve({
					d: JSON.stringify({
						Jackpot: { NextPrizePool: 500000000 },
						NextDrawingDate: '2025-12-26T00:00:00'
					})
				})
			})
		);
		mockFetch.mockImplementationOnce(() =>
			Promise.resolve({
				text: () => Promise.resolve(
					'<html>Estimated Jackpot: $400 Million</html>'
				)
			})
		);
		global.fetch = mockFetch;

		const request = new Request('http://localhost');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, { JACKPOT_THRESHOLD: '1500' }, ctx);
		const data = await response.json();

		expect(data.threshold.display).toBe('$1.50 Billion');
	});

	it('formats threshold display correctly for millions', async () => {
		const mockFetch = vi.fn();

		mockFetch.mockImplementationOnce(() =>
			Promise.resolve({
				json: () => Promise.resolve({
					d: JSON.stringify({
						Jackpot: { NextPrizePool: 500000000 },
						NextDrawingDate: '2025-12-26T00:00:00'
					})
				})
			})
		);
		mockFetch.mockImplementationOnce(() =>
			Promise.resolve({
				text: () => Promise.resolve(
					'<html>Estimated Jackpot: $400 Million</html>'
				)
			})
		);
		global.fetch = mockFetch;

		const request = new Request('http://localhost');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, { JACKPOT_THRESHOLD: '500' }, ctx);
		const data = await response.json();

		expect(data.threshold.display).toBe('$500 Million');
	});

	it('handles null/undefined jackpotAmount gracefully', async () => {
		const mockFetch = vi.fn();

		// Mock Mega Millions with valid data
		mockFetch.mockImplementationOnce(() =>
			Promise.resolve({
				json: () => Promise.resolve({
					d: JSON.stringify({
						Jackpot: { NextPrizePool: 2000000000 }, // $2B
						NextDrawingDate: '2025-12-26T00:00:00'
					})
				})
			})
		);
		// Mock Powerball with data that would produce null/undefined jackpotAmount
		mockFetch.mockImplementationOnce(() =>
			Promise.resolve({
				text: () => Promise.resolve('<html>No jackpot info here</html>')
			})
		);
		global.fetch = mockFetch;

		const request = new Request('http://localhost');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, { JACKPOT_THRESHOLD: '1500' }, ctx);
		const data = await response.json();

		// Mega Millions should exceed threshold
		expect(data.megaMillions.exceedsThreshold).toBe(true);
		// Powerball with jackpotAmount: 0 should not exceed threshold
		expect(data.powerball.exceedsThreshold).toBe(false);
		// Only Mega Millions should be in the exceeding list
		expect(data.threshold.exceeded).toBe(true);
		expect(data.threshold.exceedingLotteries).toEqual(['Mega Millions']);
	});

	it('handles errors without triggering threshold exceeded', async () => {
		const mockFetch = vi.fn();

		// Mock both APIs to fail
		mockFetch.mockImplementationOnce(() =>
			Promise.reject(new Error('Network error'))
		);
		mockFetch.mockImplementationOnce(() =>
			Promise.reject(new Error('Network error'))
		);
		global.fetch = mockFetch;

		const request = new Request('http://localhost');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, { JACKPOT_THRESHOLD: '0' }, ctx);
		const data = await response.json();

		// Neither should exceed threshold when there are errors
		expect(data.megaMillions.exceedsThreshold).toBe(false);
		expect(data.powerball.exceedsThreshold).toBe(false);
		expect(data.threshold.exceeded).toBe(false);
		expect(data.threshold.exceedingLotteries).toHaveLength(0);
	});
});

describe('Mega Millions API', () => {
	it('correctly parses API response with billion jackpot', async () => {
		const mockFetch = vi.fn().mockImplementationOnce(() =>
			Promise.resolve({
				json: () => Promise.resolve({
					d: JSON.stringify({
						Jackpot: { NextPrizePool: 1700000000 },
						NextDrawingDate: '2025-12-26T00:00:00'
					})
				})
			})
		);
		mockFetch.mockImplementationOnce(() =>
			Promise.resolve({
				text: () => Promise.resolve('<html>Powerball data</html>')
			})
		);
		global.fetch = mockFetch;

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
		const mockFetch = vi.fn().mockImplementationOnce(() =>
			Promise.resolve({
				json: () => Promise.resolve({
					d: JSON.stringify({
						Jackpot: { NextPrizePool: 500000000 }, // $500M
						NextDrawingDate: '2025-12-26T00:00:00'
					})
				})
			})
		);
		mockFetch.mockImplementationOnce(() =>
			Promise.resolve({
				text: () => Promise.resolve('<html>Powerball data</html>')
			})
		);
		global.fetch = mockFetch;

		const request = new Request('http://localhost');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		const data = await response.json();

		expect(data.megaMillions.lottery).toBe('Mega Millions');
		expect(data.megaMillions.jackpot).toContain('Million');
		expect(data.megaMillions.jackpotAmount).toBe(500);
	});

	it('handles API errors gracefully', async () => {
		const mockFetch = vi.fn().mockImplementationOnce(() =>
			Promise.reject(new Error('Network error'))
		);
		mockFetch.mockImplementationOnce(() =>
			Promise.resolve({
				text: () => Promise.resolve('<html>Powerball data</html>')
			})
		);
		global.fetch = mockFetch;

		const request = new Request('http://localhost');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		const data = await response.json();

		expect(data.megaMillions.lottery).toBe('Mega Millions');
		expect(data.megaMillions.jackpot).toBe('Error');
		expect(data.megaMillions.jackpotAmount).toBe(0);
		expect(data.megaMillions.error).toBeDefined();
	});
});

describe('Powerball scraping', () => {
	it('correctly parses HTML with billion jackpot', async () => {
		const mockFetch = vi.fn();
		mockFetch.mockImplementationOnce(() =>
			Promise.resolve({
				json: () => Promise.resolve({
					d: JSON.stringify({
						Jackpot: { NextPrizePool: 500000000 },
						NextDrawingDate: '2025-12-26T00:00:00'
					})
				})
			})
		);
		mockFetch.mockImplementationOnce(() =>
			Promise.resolve({
				text: () => Promise.resolve(
					'<html>Estimated Jackpot: $1.70 Billion Next Drawing: Friday, December 27, 2024</html>'
				)
			})
		);
		global.fetch = mockFetch;

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
		const mockFetch = vi.fn();
		mockFetch.mockImplementationOnce(() =>
			Promise.resolve({
				json: () => Promise.resolve({
					d: JSON.stringify({
						Jackpot: { NextPrizePool: 500000000 },
						NextDrawingDate: '2025-12-26T00:00:00'
					})
				})
			})
		);
		mockFetch.mockImplementationOnce(() =>
			Promise.resolve({
				text: () => Promise.resolve(
					'<html>Jackpot: $450 Million Next Drawing: Wednesday, Dec 25, 2024</html>'
				)
			})
		);
		global.fetch = mockFetch;

		const request = new Request('http://localhost');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		const data = await response.json();

		expect(data.powerball.lottery).toBe('Powerball');
		expect(data.powerball.jackpot).toContain('Million');
		expect(data.powerball.jackpotAmount).toBe(450);
	});

	it('handles different HTML patterns', async () => {
		const mockFetch = vi.fn();
		mockFetch.mockImplementationOnce(() =>
			Promise.resolve({
				json: () => Promise.resolve({
					d: JSON.stringify({
						Jackpot: { NextPrizePool: 500000000 },
						NextDrawingDate: '2025-12-26T00:00:00'
					})
				})
			})
		);
		// Alternative pattern without "Estimated" prefix
		mockFetch.mockImplementationOnce(() =>
			Promise.resolve({
				text: () => Promise.resolve(
					'<html>$1.20 Billion Wednesday, December 25, 2024</html>'
				)
			})
		);
		global.fetch = mockFetch;

		const request = new Request('http://localhost');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		const data = await response.json();

		expect(data.powerball.jackpotAmount).toBe(1200);
	});

	it('handles scraping errors gracefully', async () => {
		const mockFetch = vi.fn();
		mockFetch.mockImplementationOnce(() =>
			Promise.resolve({
				json: () => Promise.resolve({
					d: JSON.stringify({
						Jackpot: { NextPrizePool: 500000000 },
						NextDrawingDate: '2025-12-26T00:00:00'
					})
				})
			})
		);
		mockFetch.mockImplementationOnce(() =>
			Promise.reject(new Error('Network error'))
		);
		global.fetch = mockFetch;

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
		const mockFetch = vi.fn();
		mockFetch.mockImplementationOnce(() =>
			Promise.resolve({
				json: () => Promise.resolve({
					d: JSON.stringify({
						Jackpot: { NextPrizePool: 500000000 },
						NextDrawingDate: '2025-12-26T00:00:00'
					})
				})
			})
		);
		mockFetch.mockImplementationOnce(() =>
			Promise.resolve({
				text: () => Promise.resolve('<html>No jackpot data here</html>')
			})
		);
		global.fetch = mockFetch;

		const request = new Request('http://localhost');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		const data = await response.json();

		expect(data.powerball.lottery).toBe('Powerball');
		expect(data.powerball.jackpot).toBe('Not found');
		expect(data.powerball.jackpotAmount).toBe(0);
		expect(data.powerball.error).toBe('Failed to parse jackpot from HTML');
		// Should not exceed threshold when there's a scraping error
		expect(data.powerball.exceedsThreshold).toBe(false);
	});

	describe('KV Storage', () => {
		/**
		 * Create a mock KV namespace for testing
		 * @returns {Object} Mock KV namespace with get/put methods
		 */
		function createMockKV() {
			const storage = new Map();
			return {
				get: vi.fn(async (key) => storage.get(key) || null),
				put: vi.fn(async (key, value) => {
					storage.set(key, value);
				}),
				delete: vi.fn(async (key) => storage.delete(key)),
				_storage: storage // Expose for testing assertions
			};
		}

		describe('getPreviousJackpot', () => {
			it('returns 0 when key does not exist', async () => {
				const mockKV = createMockKV();
				const { getPreviousJackpot } = await import('./index.js');

				const result = await getPreviousJackpot(mockKV, 'Mega Millions');

				expect(result).toBe(0);
				expect(mockKV.get).toHaveBeenCalledWith('Mega Millions');
			});

			it('returns stored value when key exists', async () => {
				const mockKV = createMockKV();
				const { getPreviousJackpot } = await import('./index.js');

				// Store a previous jackpot value
				const storedData = {
					jackpotAmount: 1500,
					lastChecked: '2025-12-25T20:00:00.000Z'
				};
				mockKV._storage.set('Mega Millions', JSON.stringify(storedData));

				const result = await getPreviousJackpot(mockKV, 'Mega Millions');

				expect(result).toBe(1500);
			});

			it('handles malformed JSON gracefully', async () => {
				const mockKV = createMockKV();
				const { getPreviousJackpot } = await import('./index.js');

				// Store invalid JSON
				mockKV._storage.set('Powerball', 'not valid json {');

				const result = await getPreviousJackpot(mockKV, 'Powerball');

				expect(result).toBe(0);
			});

			it('handles undefined KV namespace gracefully', async () => {
				const { getPreviousJackpot } = await import('./index.js');

				const result = await getPreviousJackpot(undefined, 'Mega Millions');

				expect(result).toBe(0);
			});

			it('handles missing jackpotAmount field', async () => {
				const mockKV = createMockKV();
				const { getPreviousJackpot } = await import('./index.js');

				// Store data without jackpotAmount field
				const storedData = {
					lastChecked: '2025-12-25T20:00:00.000Z'
				};
				mockKV._storage.set('Powerball', JSON.stringify(storedData));

				const result = await getPreviousJackpot(mockKV, 'Powerball');

				expect(result).toBe(0);
			});
		});

		describe('storePreviousJackpot', () => {
			it('writes correct format to KV', async () => {
				const mockKV = createMockKV();
				const { storePreviousJackpot } = await import('./index.js');

				await storePreviousJackpot(mockKV, 'Mega Millions', 1700);

				expect(mockKV.put).toHaveBeenCalledWith('Mega Millions', expect.any(String));

				// Verify the stored data structure
				const storedValue = mockKV._storage.get('Mega Millions');
				const data = JSON.parse(storedValue);

				expect(data.jackpotAmount).toBe(1700);
				expect(data).toHaveProperty('lastChecked');
			});

			it('includes timestamp in stored data', async () => {
				const mockKV = createMockKV();
				const { storePreviousJackpot } = await import('./index.js');

				const beforeTime = new Date().toISOString();
				await storePreviousJackpot(mockKV, 'Powerball', 1500);
				const afterTime = new Date().toISOString();

				const storedValue = mockKV._storage.get('Powerball');
				const data = JSON.parse(storedValue);

				// Verify timestamp is a valid ISO string
				expect(() => new Date(data.lastChecked)).not.toThrow();
				// Timestamp should be between before and after
				expect(data.lastChecked >= beforeTime).toBe(true);
				expect(data.lastChecked <= afterTime).toBe(true);
			});

			it('handles undefined KV namespace gracefully', async () => {
				const { storePreviousJackpot } = await import('./index.js');

				// Should not throw
				await expect(
					storePreviousJackpot(undefined, 'Mega Millions', 1700)
				).resolves.toBeUndefined();
			});

			it('handles KV put errors gracefully', async () => {
				const mockKV = {
					put: vi.fn().mockRejectedValue(new Error('KV write failed'))
				};
				const { storePreviousJackpot } = await import('./index.js');

				// Mock console.error to verify error logging
				const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

				// Should not throw
				await expect(
					storePreviousJackpot(mockKV, 'Powerball', 1500)
				).resolves.toBeUndefined();

				expect(consoleErrorSpy).toHaveBeenCalled();

				// Restore console.error
				consoleErrorSpy.mockRestore();
			});
		});
	});
});
