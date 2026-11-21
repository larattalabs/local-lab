export interface PromptModifier {
  id: string
  name: string
  description: string
  instructions: string
  motionInstructions: string
}
export type ModifierKind = 'moods' | 'intensities'
export interface ModifierConfig {
  revision: number
  moods: PromptModifier[]
  intensities: PromptModifier[]
}
export interface ModifierSnapshot {
  revision: number
  mood: PromptModifier
  intensity: PromptModifier
}
export function defaultModifiers(): ModifierConfig {
  return {
    revision: 0,
    moods: [
      { id: 'glamour', name: 'Glamour', description: 'Polished portrait styling.', instructions: 'Style: glamour.', motionInstructions: '' },
      { id: 'pin-up', name: 'Pin-up', description: 'Playful editorial posing.', instructions: 'Style: pin-up.', motionInstructions: '' },
      { id: 'boudoir', name: 'Boudoir', description: 'An intimate portrait atmosphere.', instructions: 'Style: boudoir.', motionInstructions: '' },
      { id: 'swimwear', name: 'Swimwear', description: 'Swimwear photography and styling.', instructions: 'Style: swimwear.', motionInstructions: '' },
    ],
    intensities: [
      { id: 'low', name: 'Low · Subtle', description: 'The existing treatment, with no extra intensity instructions.', instructions: '', motionInstructions: '' },
      { id: 'medium', name: 'Medium · Bold', description: 'Confident poses, expressive posture and intentional framing.', instructions: 'INTENSITY: BOLD. Express the chosen mood through confident posing, sustained eye contact, expressive posture, and intentional framing. Preserve the requested wardrobe, identity, body proportions, setting, and action.', motionInstructions: 'Express confidence through one clear, controlled movement, matched to the available duration.' },
      { id: 'high', name: 'High · Dramatic', description: 'Striking editorial poses, silhouettes and dramatic lighting.', instructions: 'INTENSITY: DRAMATIC. Emphasize the chosen mood through striking editorial poses, strong silhouettes, assertive expressions, and dramatic but believable lighting. Preserve the user’s explicit scene details, wardrobe, identity and body proportions.', motionInstructions: 'Use one deliberate movement with a clear beginning and end, matched to the clip duration.' },
    ],
  }
}
export function modifierPrompt(snapshot: ModifierSnapshot, video: boolean): string {
  return [snapshot.mood.instructions, snapshot.intensity.instructions,
    ...(video ? [snapshot.mood.motionInstructions, snapshot.intensity.motionInstructions] : [])]
    .map((s) => s.trim()).filter(Boolean).join('\n')
}
