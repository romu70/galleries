import { z } from "astro/zod";
import { defineCollection, reference, type SchemaContext } from "astro:content";
import { glob } from "astro/loaders";

// Fields shared by fonts and street art.
function getBaseSchema(params: SchemaContext) {
  return z.object({
    place: z.string(),
    pubDate: z.coerce.date(),
    geo: z.string(),
    image: z.object({
      file: params.image(),
    }),
    tag: z.string(),
  });
}

// Street art adds the wall the photo belongs to.
// Missing or null both mean "not processed yet" by the gallery-walls skill.
function getStreetartSchema(params: SchemaContext) {
  return getBaseSchema(params).extend({
    wall: reference("walls").nullish(),
  });
}

const fonts = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/fonts" }),
  schema: getBaseSchema,
});

const streetarts = defineCollection({
  loader: glob({ pattern: "**/*.json", base: "./src/content/streetarts" }),
  schema: getStreetartSchema,
});

// One physical painted surface. The file name is the wall id: <town>-wNNN.
const walls = defineCollection({
  loader: glob({ pattern: "**/*.json", base: "./src/content/walls" }),
  schema: z.object({
    place: z.string(),
    lat: z.number().min(-90).max(90).optional(),
    lon: z.number().min(-180).max(180).optional(),
    label: z.string().optional(),
  }),
});

// Export a single `collections` object to register your collection(s)
export const collections = {
  fonts: fonts,
  streetarts: streetarts,
  walls: walls,
};
