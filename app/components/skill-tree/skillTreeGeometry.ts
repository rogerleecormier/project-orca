/**
 * Compute display radius from node type and XP reward.
 *
 * Size tiers (clear delineation for children):
 *   boss       — 40px base  (dominant capstone, always biggest)
 *   milestone  — 30px base  (chapter entry points, clearly large)
 *   lesson     — 20px base  (core topic nodes, medium)
 *   branch     — 20px base  (hub nodes, same as lesson)
 *   elective   — 14px base  (optional deep dives, clearly smallest)
 *
 * XP scales within each tier (±25% of base) so high-XP lessons
 * are visibly larger than low-XP ones, but never overlap the tier above.
 */
export function computeSkillTreeNodeRadius(nodeType: string, xpReward: number): number {
  const base: Record<string, number> = {
    boss: 40,
    milestone: 30,
    lesson: 20,
    branch: 20,
    elective: 14,
  };
  const b = base[nodeType] ?? 20;
  const t = Math.min(1, Math.max(0, (xpReward - 50) / 950));
  return Math.round(b * (1 + 0.25 * t));
}
