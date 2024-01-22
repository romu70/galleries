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

// Export a single `collections` object to register your collection(s)
export const collections = {
  fonts: fonts,
};
