/**
 * Compute display radius from node type and XP reward.
 *
 * Optional nodes get an extra size reduction even if they share the same
 * node type as required nodes. This keeps side branches visually secondary.
 */
export function computeSkillTreeNodeRadius(
  nodeType: string,
  xpReward: number,
  isRequired = true,
): number {
  const base: Record<string, number> = {
    boss: 40,
    milestone: 30,
    lesson: 20,
    branch: 20,
    elective: 14,
  };
  const b = base[nodeType] ?? 20;
  const t = Math.min(1, Math.max(0, (xpReward - 50) / 950));
  const scaled = b * (1 + 0.25 * t);
  const optionalScale = isRequired ? 1 : 0.82;
  const minRadius = nodeType === "boss" ? 24 : nodeType === "milestone" ? 18 : 10;
  return Math.max(minRadius, Math.round(scaled * optionalScale));
}
