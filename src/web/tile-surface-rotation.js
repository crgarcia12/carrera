function positiveModulo(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

export function getTileSurfaceRotationDegrees(tileType, rotation = 0) {
  const normalizedRotation = positiveModulo(rotation, 360);

  switch (tileType) {
    case "straight":
      return positiveModulo(90 - normalizedRotation, 360);
    case "curve":
      return positiveModulo(-normalizedRotation - 90, 360);
    default:
      return normalizedRotation;
  }
}
