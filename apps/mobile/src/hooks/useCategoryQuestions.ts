export interface FollowUp {
  question: string
  options: string[]
  keywords: string[]
}

const CATEGORY_FOLLOW_UPS: Record<string, FollowUp[]> = {
  massage: [
    {
      question: "Do you have a preference for your therapist's gender?",
      options: ['Female only', 'Male only', 'No preference'],
      keywords: ['female', 'male', 'woman', 'man', 'lady', 'gender'],
    },
  ],
  spa: [
    {
      question: 'Gender preference for your therapist?',
      options: ['Female only', 'Male only', 'No preference'],
      keywords: ['female', 'male', 'gender'],
    },
  ],
  salon: [
    {
      question: 'Do you prefer a female or male stylist?',
      options: ['Female', 'Male', 'No preference'],
      keywords: ['female', 'male', 'gender', 'lady'],
    },
  ],
  photography: [
    {
      question: 'Will this be indoors or outdoors?',
      options: ['Indoors', 'Outdoors', 'Both'],
      keywords: ['indoor', 'outdoor', 'inside', 'outside'],
    },
    {
      question: 'Roughly how many hours do you need?',
      options: ['1–2 hours', '3–4 hours', 'Full day', 'Not sure yet'],
      keywords: ['hour', 'hrs', 'day', 'duration'],
    },
  ],
  videography: [
    {
      question: 'Indoors or outdoors?',
      options: ['Indoors', 'Outdoors', 'Both'],
      keywords: ['indoor', 'outdoor'],
    },
  ],
  electrical: [
    {
      question: 'Is this for a home or a commercial space?',
      options: ['Home', 'Office / Commercial'],
      keywords: ['home', 'house', 'office', 'commercial', 'flat', 'apartment'],
    },
  ],
  plumbing: [
    {
      question: 'Home or commercial space?',
      options: ['Home', 'Office / Commercial'],
      keywords: ['home', 'house', 'office', 'commercial'],
    },
  ],
  carpentry: [
    {
      question: 'Home or commercial space?',
      options: ['Home', 'Office / Commercial'],
      keywords: ['home', 'house', 'office', 'commercial'],
    },
  ],
  tutoring: [
    {
      question: 'Which subject or skill?',
      options: ['Maths', 'Science', 'English', 'Coding'],
      keywords: ['math', 'science', 'english', 'coding', 'subject'],
    },
    {
      question: 'What grade or level?',
      options: ['Primary', 'Grade 6–10', 'Grade 11–12', 'College / Adult'],
      keywords: ['grade', 'class', 'level', 'beginner'],
    },
  ],
  auto: [
    {
      question: 'One-way or round trip?',
      options: ['One-way', 'Round trip', 'Need to wait there'],
      keywords: ['one-way', 'round trip', 'return', 'back'],
    },
  ],
  bike: [
    {
      question: 'One-way or round trip?',
      options: ['One-way', 'Round trip'],
      keywords: ['one-way', 'round', 'return'],
    },
  ],
  catering: [
    {
      question: 'How many people?',
      options: ['Under 20', '20–50', '50–100', '100+'],
      keywords: ['people', 'persons', 'guests', 'pax'],
    },
    {
      question: 'Veg, non-veg, or both?',
      options: ['Veg only', 'Non-veg', 'Both'],
      keywords: ['veg', 'non-veg', 'vegetarian', 'chicken'],
    },
  ],
  cleaning: [
    {
      question: 'How many BHK?',
      options: ['1 BHK', '2 BHK', '3 BHK', 'Villa / larger'],
      keywords: ['bhk', 'bedroom', 'rooms'],
    },
  ],
  movers: [
    {
      question: 'Moving within Hyderabad or to another city?',
      options: ['Within Hyderabad', 'Another city'],
      keywords: ['within', 'city', 'outside', 'bangalore', 'chennai'],
    },
  ],
}

/**
 * Returns only the follow-up questions whose answers are NOT already
 * present in the user's original text.
 */
export function getFollowUpQuestions(
  categoryTags: string[],
  text: string
): FollowUp[] {
  const lower = text.toLowerCase()
  const result: FollowUp[] = []

  for (const [key, followUps] of Object.entries(CATEGORY_FOLLOW_UPS)) {
    const matched = categoryTags.some((tag) => tag.toLowerCase().includes(key))
    if (!matched) continue

    for (const fu of followUps) {
      const alreadyAnswered = fu.keywords.some((kw) => lower.includes(kw))
      if (!alreadyAnswered) result.push(fu)
    }
  }

  return result
}
