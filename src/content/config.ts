// Import utilities from `astro:content`
import { z, defineCollection, type ImageFunction, type SchemaContext } from "astro:content";

function getSchema(params: SchemaContext) {
  return z.object({
    place: z.string(),
    pubDate: z.coerce.date(),
    geo: z.string(),
    image: z.object({
      file: params.image(),
      alt: z.string(),
    }),
    tag: z.string()
  });
}

// Define a `type` and `schema` for each collection
const fonts = defineCollection({
  type: 'content',
  schema: getSchema,
});

const streetarts = defineCollection({
  type: 'data',
  schema: getSchema,
});

// Export a single `collections` object to register your collection(s)
export const collections = {
  fonts: fonts,
  streetarts: streetarts
};
