export function gcd(a: bigint, b: bigint): bigint {
  if (a < 0n) a = -a;
  if (b < 0n) b = -b;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

export function primesThrough(limit: number): number[] {
  if (limit < 2) return [];
  const composite = new Uint8Array(limit + 1);
  for (let p = 2; p * p <= limit; p++) {
    if (composite[p]) continue;
    for (let multiple = p * p; multiple <= limit; multiple += p) composite[multiple] = 1;
  }
  const primes: number[] = [];
  for (let n = 2; n <= limit; n++) if (!composite[n]) primes.push(n);
  return primes;
}

export function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  if (modulus <= 0n || exponent < 0n) throw new RangeError('expected positive modulus and nonnegative exponent');
  let power = ((base % modulus) + modulus) % modulus;
  let result = 1n % modulus;
  while (exponent > 0n) {
    if (exponent % 2n === 1n) result = result * power % modulus;
    power = power * power % modulus;
    exponent /= 2n;
  }
  return result;
}
