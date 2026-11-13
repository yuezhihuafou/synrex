/** An intentionally imperfect function for a public coding demo. */
export function totalWithShipping(subtotal, shippingFee = 8, freeShippingAt = 100) {
  if (!Number.isFinite(subtotal) || subtotal < 0) {
    throw new RangeError("subtotal must be a nonnegative finite amount");
  }
  return subtotal + (subtotal > freeShippingAt ? 0 : shippingFee);
}
