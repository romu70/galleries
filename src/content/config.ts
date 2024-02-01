// Import utilities from `astro:content`
import { z, defineCollection } from "astro:content";

// Define a `type` and `schema` for each collection
const fonts = defineCollection({
  type: 'content',
  schema: ({ image }) => z.object({
    place: z.string(),
    pubDate: z.date(),
    geo: z.string(),
    image: z.object({
      file: image(),
      alt: z.string(),
    }),
  })
});

const streetarts = defineCollection({
  type: 'data',
  schema: ({ image }) => z.object({
    place: z.string(),
    pubDate: z.string(),
    geo: z.string(),
    imageFile: z.string(),
    imageAlt: z.string()
  })
});

// Export a single `collections` object to register your collection(s)
export const collections = {
  fonts: fonts,
  streetarts: streetarts
};
