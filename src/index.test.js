import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import worker, { detectThresholdCrossing, buildNotificationEmail, sendEmail, isEmailConfigured } from './index.js';

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

	it('correctly parses abbreviated date format (Mon, Jan 5, 2026)', async () => {
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
					'<html><h5>Mon, Jan 5, 2026</h5>Estimated Jackpot $86 Million</html>'
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
		expect(data.powerball.jackpotAmount).toBe(86);
		expect(data.powerball.nextDrawing).toBe('Mon, Jan 5, 2026');
	});

	it('correctly parses abbreviated date with Next Drawing header', async () => {
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
					'<html>Next Drawing<h5>Wed, Dec 11, 2024</h5>Estimated Jackpot: $150 Million</html>'
				)
			})
		);
		global.fetch = mockFetch;

		const request = new Request('http://localhost');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		const data = await response.json();

		expect(data.powerball.nextDrawing).toBe('Wed, Dec 11, 2024');
		expect(data.powerball.jackpotAmount).toBe(150);
	});

	it('handles both abbreviated and full date formats', async () => {
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
		// Test with full format still works
		mockFetch.mockImplementationOnce(() =>
			Promise.resolve({
				text: () => Promise.resolve(
					'<html>Estimated Jackpot: $200 Million Next Drawing: Saturday, March 15, 2025</html>'
				)
			})
		);
		global.fetch = mockFetch;

		const request = new Request('http://localhost');
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		const data = await response.json();

		expect(data.powerball.nextDrawing).toBe('Saturday, March 15, 2025');
		expect(data.powerball.jackpotAmount).toBe(200);
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

/**
 * Unit Tests for Core Notification Functions
 */

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
		expect(result.previousAmount).toBe(1000);
		expect(result.currentAmount).toBe(1500);
		expect(result.threshold).toBe(1500);
	});

	it('does not detect crossing when staying above threshold', () => {
		const result = detectThresholdCrossing(1600, 1800, 1500);

		expect(result.crossed).toBe(false);
		expect(result.previousAmount).toBe(1600);
		expect(result.currentAmount).toBe(1800);
		expect(result.threshold).toBe(1500);
	});

	it('does not detect crossing when staying below threshold', () => {
		const result = detectThresholdCrossing(1000, 1200, 1500);

		expect(result.crossed).toBe(false);
		expect(result.previousAmount).toBe(1000);
		expect(result.currentAmount).toBe(1200);
		expect(result.threshold).toBe(1500);
	});

	it('does not detect crossing when going from above to below threshold', () => {
		// This prevents notifications on downward movements
		const result = detectThresholdCrossing(1800, 1200, 1500);

		expect(result.crossed).toBe(false);
		expect(result.previousAmount).toBe(1800);
		expect(result.currentAmount).toBe(1200);
		expect(result.threshold).toBe(1500);
	});

	it('handles zero previous amount crossing threshold', () => {
		const result = detectThresholdCrossing(0, 1600, 1500);

		expect(result.crossed).toBe(true);
		expect(result.previousAmount).toBe(0);
		expect(result.currentAmount).toBe(1600);
		expect(result.threshold).toBe(1500);
	});

	it('does not detect crossing when both amounts are zero', () => {
		const result = detectThresholdCrossing(0, 0, 1500);

		expect(result.crossed).toBe(false);
	});

	it('handles very large jackpot amounts', () => {
		const result = detectThresholdCrossing(2500, 3000, 2800);

		expect(result.crossed).toBe(true);
		expect(result.previousAmount).toBe(2500);
		expect(result.currentAmount).toBe(3000);
		expect(result.threshold).toBe(2800);
	});
});

describe('buildNotificationEmail', () => {
	it('generates valid HTML email with all required elements', () => {
		const html = buildNotificationEmail('Mega Millions', 1000, 1700, 1500, 'Fri, Dec 26, 2025');

		// Check HTML structure
		expect(html).toContain('<!DOCTYPE html>');
		expect(html).toContain('<html>');
		expect(html).toContain('</html>');
		expect(html).toContain('<body>');
		expect(html).toContain('</body>');
	});

	it('includes lottery name in email content', () => {
		const html = buildNotificationEmail('Mega Millions', 1000, 1700, 1500, 'Fri, Dec 26, 2025');

		expect(html).toContain('Mega Millions');
		expect(html).toContain('has crossed your threshold');
	});

	it('displays previous amount correctly formatted', () => {
		const html = buildNotificationEmail('Powerball', 1000, 1700, 1500, 'Sat, Dec 27, 2025');

		expect(html).toContain('Previous');
		expect(html).toContain('$1.00 Billion');
	});

	it('displays current amount correctly formatted', () => {
		const html = buildNotificationEmail('Mega Millions', 1000, 1700, 1500, 'Fri, Dec 26, 2025');

		expect(html).toContain('Current');
		expect(html).toContain('$1.70 Billion');
	});

	it('displays threshold correctly formatted', () => {
		const html = buildNotificationEmail('Mega Millions', 1000, 1700, 1500, 'Fri, Dec 26, 2025');

		expect(html).toContain('Your threshold');
		expect(html).toContain('$1.50 Billion');
	});

	it('includes next drawing date', () => {
		const html = buildNotificationEmail('Powerball', 1000, 1800, 1500, 'Saturday, Dec 28, 2025');

		expect(html).toContain('Next drawing');
		expect(html).toContain('Saturday, Dec 28, 2025');
	});

	it('formats amounts in millions correctly', () => {
		const html = buildNotificationEmail('Mega Millions', 450, 650, 500, 'Fri, Dec 26, 2025');

		expect(html).toContain('$450 Million');
		expect(html).toContain('$650 Million');
		expect(html).toContain('$500 Million');
	});

	it('formats amounts in billions correctly', () => {
		const html = buildNotificationEmail('Powerball', 1500, 2000, 1800, 'Sat, Dec 27, 2025');

		expect(html).toContain('$1.50 Billion');
		expect(html).toContain('$2.00 Billion');
		expect(html).toContain('$1.80 Billion');
	});

	it('includes automated notification footer', () => {
		const html = buildNotificationEmail('Mega Millions', 1000, 1700, 1500, 'Fri, Dec 26, 2025');

		expect(html).toContain('automated notification');
		expect(html).toContain('LottoCheck');
	});

	it('includes CSS styling for email formatting', () => {
		const html = buildNotificationEmail('Mega Millions', 1000, 1700, 1500, 'Fri, Dec 26, 2025');

		expect(html).toContain('<style>');
		expect(html).toContain('font-family');
		expect(html).toContain('.container');
	});

	it('includes jackpot alert emoji/icon', () => {
		const html = buildNotificationEmail('Powerball', 1000, 1700, 1500, 'Sat, Dec 27, 2025');

		expect(html).toContain('🎰');
		expect(html).toContain('Lottery Jackpot Alert');
	});

	it('handles very large jackpot amounts', () => {
		const html = buildNotificationEmail('Mega Millions', 2500, 3500, 3000, 'Fri, Dec 26, 2025');

		expect(html).toContain('$2.50 Billion');
		expect(html).toContain('$3.50 Billion');
		expect(html).toContain('$3.00 Billion');
	});

	describe('input validation', () => {
		it('throws error when lotteryName is null', () => {
			expect(() => buildNotificationEmail(null, 1000, 1700, 1500, 'Fri, Dec 26, 2025'))
				.toThrow('lotteryName must be a non-empty string');
		});

		it('throws error when lotteryName is undefined', () => {
			expect(() => buildNotificationEmail(undefined, 1000, 1700, 1500, 'Fri, Dec 26, 2025'))
				.toThrow('lotteryName must be a non-empty string');
		});

		it('throws error when lotteryName is empty string', () => {
			expect(() => buildNotificationEmail('', 1000, 1700, 1500, 'Fri, Dec 26, 2025'))
				.toThrow('lotteryName must be a non-empty string');
		});

		it('throws error when lotteryName is not a string', () => {
			expect(() => buildNotificationEmail(123, 1000, 1700, 1500, 'Fri, Dec 26, 2025'))
				.toThrow('lotteryName must be a non-empty string');
		});

		it('throws error when previousAmount is not a number', () => {
			expect(() => buildNotificationEmail('Mega Millions', 'invalid', 1700, 1500, 'Fri, Dec 26, 2025'))
				.toThrow('previousAmount must be a valid number');
		});

		it('throws error when previousAmount is NaN', () => {
			expect(() => buildNotificationEmail('Mega Millions', NaN, 1700, 1500, 'Fri, Dec 26, 2025'))
				.toThrow('previousAmount must be a valid number');
		});

		it('throws error when currentAmount is not a number', () => {
			expect(() => buildNotificationEmail('Mega Millions', 1000, 'invalid', 1500, 'Fri, Dec 26, 2025'))
				.toThrow('currentAmount must be a valid number');
		});

		it('throws error when currentAmount is NaN', () => {
			expect(() => buildNotificationEmail('Mega Millions', 1000, NaN, 1500, 'Fri, Dec 26, 2025'))
				.toThrow('currentAmount must be a valid number');
		});

		it('throws error when threshold is not a number', () => {
			expect(() => buildNotificationEmail('Mega Millions', 1000, 1700, 'invalid', 'Fri, Dec 26, 2025'))
				.toThrow('threshold must be a valid number');
		});

		it('throws error when threshold is NaN', () => {
			expect(() => buildNotificationEmail('Mega Millions', 1000, 1700, NaN, 'Fri, Dec 26, 2025'))
				.toThrow('threshold must be a valid number');
		});

		it('throws error when nextDrawing is null', () => {
			expect(() => buildNotificationEmail('Mega Millions', 1000, 1700, 1500, null))
				.toThrow('nextDrawing must be a non-empty string');
		});

		it('throws error when nextDrawing is undefined', () => {
			expect(() => buildNotificationEmail('Mega Millions', 1000, 1700, 1500, undefined))
				.toThrow('nextDrawing must be a non-empty string');
		});

		it('throws error when nextDrawing is empty string', () => {
			expect(() => buildNotificationEmail('Mega Millions', 1000, 1700, 1500, ''))
				.toThrow('nextDrawing must be a non-empty string');
		});

		it('throws error when nextDrawing is not a string', () => {
			expect(() => buildNotificationEmail('Mega Millions', 1000, 1700, 1500, 123))
				.toThrow('nextDrawing must be a non-empty string');
		});
	});
});

describe('sendEmail', () => {
	it('successfully sends email when API responds with OK', async () => {
		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200
		});
		global.fetch = mockFetch;

		const result = await sendEmail(
			'from@example.com',
			'to@example.com',
			'Test Subject',
			'<html>Test Body</html>'
		);

		expect(result.success).toBe(true);
		expect(result.error).toBeUndefined();
		expect(mockFetch).toHaveBeenCalledTimes(1);
	});

	it('calls MailChannels API with correct endpoint', async () => {
		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200
		});
		global.fetch = mockFetch;

		await sendEmail(
			'from@example.com',
			'to@example.com',
			'Test Subject',
			'<html>Test</html>'
		);

		expect(mockFetch).toHaveBeenCalledWith(
			'https://api.mailchannels.net/tx/v1/send',
			expect.any(Object)
		);
	});

	it('sends correct email structure to MailChannels', async () => {
		const mockFetch = vi.fn().mockResolvedValue({
			ok: true,
			status: 200
		});
		global.fetch = mockFetch;

		await sendEmail(
			'sender@domain.com',
			'recipient@domain.com',
			'Jackpot Alert',
			'<html>Email Content</html>'
		);

		const callArgs = mockFetch.mock.calls[0][1];
		expect(callArgs.method).toBe('POST');
		expect(callArgs.headers['Content-Type']).toBe('application/json');

		const body = JSON.parse(callArgs.body);
		expect(body.personalizations[0].to[0].email).toBe('recipient@domain.com');
		expect(body.from.email).toBe('sender@domain.com');
		expect(body.subject).toBe('Jackpot Alert');
		expect(body.content[0].type).toBe('text/html');
		expect(body.content[0].value).toBe('<html>Email Content</html>');
	});

	it('returns error when API responds with error status', async () => {
		const mockFetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 500,
			statusText: 'Internal Server Error',
			text: () => Promise.resolve('Server error details')
		});
		global.fetch = mockFetch;

		const result = await sendEmail(
			'from@example.com',
			'to@example.com',
			'Test',
			'<html>Test</html>'
		);

		expect(result.success).toBe(false);
		expect(result.error).toContain('MailChannels API error');
		expect(result.error).toContain('500');
		expect(result.error).toContain('Internal Server Error');
	});

	it('handles network errors gracefully', async () => {
		const mockFetch = vi.fn().mockRejectedValue(new Error('Network timeout'));
		global.fetch = mockFetch;

		const result = await sendEmail(
			'from@example.com',
			'to@example.com',
			'Test',
			'<html>Test</html>'
		);

		expect(result.success).toBe(false);
		expect(result.error).toContain('Email send failed');
		expect(result.error).toContain('Network timeout');
	});

	it('handles API authentication errors (401)', async () => {
		const mockFetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 401,
			statusText: 'Unauthorized',
			text: () => Promise.resolve('Invalid credentials')
		});
		global.fetch = mockFetch;

		const result = await sendEmail(
			'from@example.com',
			'to@example.com',
			'Test',
			'<html>Test</html>'
		);

		expect(result.success).toBe(false);
		expect(result.error).toContain('401');
		expect(result.error).toContain('Unauthorized');
	});

	it('handles API rate limiting errors (429)', async () => {
		const mockFetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 429,
			statusText: 'Too Many Requests',
			text: () => Promise.resolve('Rate limit exceeded')
		});
		global.fetch = mockFetch;

		const result = await sendEmail(
			'from@example.com',
			'to@example.com',
			'Test',
			'<html>Test</html>'
		);

		expect(result.success).toBe(false);
		expect(result.error).toContain('429');
		expect(result.error).toContain('Rate limit exceeded');
	});

	it('includes error response body in error message', async () => {
		const mockFetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 400,
			statusText: 'Bad Request',
			text: () => Promise.resolve('Invalid email format')
		});
		global.fetch = mockFetch;

		const result = await sendEmail(
			'invalid-email',
			'to@example.com',
			'Test',
			'<html>Test</html>'
		);

		expect(result.success).toBe(false);
		expect(result.error).toContain('Invalid email format');
	});

	it('handles fetch throwing non-Error objects', async () => {
		const mockFetch = vi.fn().mockRejectedValue('String error');
		global.fetch = mockFetch;

		const result = await sendEmail(
			'from@example.com',
			'to@example.com',
			'Test',
			'<html>Test</html>'
		);

		expect(result.success).toBe(false);
		expect(result.error).toBeDefined();
	});

	it('handles response.text() throwing an error', async () => {
		const mockFetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 500,
			statusText: 'Internal Server Error',
			text: () => Promise.reject(new Error('Failed to read response'))
		});
		global.fetch = mockFetch;

		const result = await sendEmail(
			'from@example.com',
			'to@example.com',
			'Test',
			'<html>Test</html>'
		);

		expect(result.success).toBe(false);
		expect(result.error).toContain('MailChannels API error');
		expect(result.error).toContain('500');
		expect(result.error).toContain('(unable to read error response)');
	});
});

describe('isEmailConfigured', () => {
	it('returns true when both FROM_EMAIL and TO_EMAIL are set', () => {
		const mockEnv = {
			FROM_EMAIL: 'from@example.com',
			TO_EMAIL: 'to@example.com'
		};

		expect(isEmailConfigured(mockEnv)).toBe(true);
	});

	it('returns false when FROM_EMAIL is missing', () => {
		const mockEnv = {
			TO_EMAIL: 'to@example.com'
		};

		expect(isEmailConfigured(mockEnv)).toBe(false);
	});

	it('returns false when TO_EMAIL is missing', () => {
		const mockEnv = {
			FROM_EMAIL: 'from@example.com'
		};

		expect(isEmailConfigured(mockEnv)).toBe(false);
	});

	it('returns false when both emails are missing', () => {
		const mockEnv = {};

		expect(isEmailConfigured(mockEnv)).toBe(false);
	});

	it('returns false when env is undefined', () => {
		expect(isEmailConfigured(undefined)).toBe(false);
	});

	it('returns false when env is null', () => {
		expect(isEmailConfigured(null)).toBe(false);
	});

	it('returns false when FROM_EMAIL is empty string', () => {
		const mockEnv = {
			FROM_EMAIL: '',
			TO_EMAIL: 'to@example.com'
		};

		expect(isEmailConfigured(mockEnv)).toBe(false);
	});

	it('returns false when TO_EMAIL is empty string', () => {
		const mockEnv = {
			FROM_EMAIL: 'from@example.com',
			TO_EMAIL: ''
		};

		expect(isEmailConfigured(mockEnv)).toBe(false);
	});
});
