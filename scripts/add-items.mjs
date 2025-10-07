
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

// --- CONFIGURATION ---
const MAX_DIMENSION = 1600;
const CONTENT_DIR = 'src/content';
const IMG_SOURCE_DIR = 'inbox';
const PROCESSED_DIR = path.join(IMG_SOURCE_DIR, 'processed');
const GALLERY_TYPE = process.argv[2];

// --- VALIDATION ---
if (!GALLERY_TYPE) {
  console.error('Usage: node scripts/add-items.mjs <gallery-type>');
  console.error('Example: node scripts/add-items.mjs fonts');
  process.exit(1);
}

if (GALLERY_TYPE !== 'fonts' && GALLERY_TYPE !== 'streetarts') {
  console.error('Error: <gallery-type> must be either "fonts" or "streetarts".');
  process.exit(1);
}

const targetDir = path.join(CONTENT_DIR, GALLERY_TYPE);
if (!fs.existsSync(targetDir)) {
  console.error(`Error: Target directory not found at ${targetDir}`);
  process.exit(1);
}
if (!fs.existsSync(IMG_SOURCE_DIR)) {
    console.error(`Error: Source directory not found at ${IMG_SOURCE_DIR}`);
    process.exit(1);
}

// --- SCRIPT ---
console.log(`Processing images from "${IMG_SOURCE_DIR}" for "${GALLERY_TYPE}" gallery...`);

const imagesDir = path.join(targetDir, 'images');
if (!fs.existsSync(imagesDir)) {
  fs.mkdirSync(imagesDir, { recursive: true });
}

const filesToProcess = fs.readdirSync(IMG_SOURCE_DIR).filter(file => {
    // Add filters for common image types, ignoring system files like .DS_Store
    return ['.heic', '.jpg', '.jpeg', '.png', '.webp'].some(ext => file.toLowerCase().endsWith(ext));
});

if (filesToProcess.length === 0) {
    console.log("No image files found to process in the source directory.");
    process.exit(0);
}

// Use a map to keep track of the last index used for each date
const dateIndexMap = new Map();

filesToProcess.forEach((file, i) => {
    const sourceImagePath = path.join(IMG_SOURCE_DIR, file);
    let datePrefix;
    let pubDate;

    try {
        // Use mdls to get the content creation date. The -raw flag gives us just the value.
        const creationDateOutput = execSync(`mdls -name kMDItemContentCreationDate -raw "${sourceImagePath}"`).toString();
        // The output is a string like "YYYY-MM-DD HH:MM:SS +ZZZZ" which can be parsed by the Date constructor.
        const creationDate = new Date(creationDateOutput);

        pubDate = creationDate.toISOString().split('T')[0];
        const year = creationDate.getFullYear();
        const month = (creationDate.getMonth() + 1).toString().padStart(2, '0');
        const day = creationDate.getDate().toString().padStart(2, '0');
        datePrefix = `${year}-${month}-${day}`;
    } catch (error) {
        console.warn(`Warning: Could not read shooting date for ${file}. Falling back to current date.`);
        const today = new Date();
        const year = today.getFullYear();
        const month = (today.getMonth() + 1).toString().padStart(2, '0');
        const day = today.getDate().toString().padStart(2, '0');
        datePrefix = `${year}-${month}-${day}`;
        pubDate = today.toISOString().split('T')[0];
    }

    // Determine the index for the file based on its date
    if (!dateIndexMap.has(datePrefix)) {
        // If we haven't seen this date before, find the last index from existing files
        const existingFiles = fs.readdirSync(targetDir);
        let lastIndex = 0;
        existingFiles.forEach(f => {
            if (f.startsWith(datePrefix)) {
                const parts = f.split('-');
                const indexPart = parts[parts.length - 1].split('.')[0];
                const index = parseInt(indexPart, 10);
                if (index > lastIndex) {
                    lastIndex = index;
                }
            }
        });
        dateIndexMap.set(datePrefix, lastIndex);
    }

    const newIndexValue = dateIndexMap.get(datePrefix) + 1;
    dateIndexMap.set(datePrefix, newIndexValue);
    const newIndex = newIndexValue.toString().padStart(2, '0');
    const newBaseName = `${datePrefix}-${newIndex}`;

    // Process and save the image
    const newImageName = `${newBaseName}.jpg`;
    const destImagePath = path.join(imagesDir, newImageName);
    console.log(`[${i + 1}/${filesToProcess.length}] Processing ${file} -> images/${newImageName}`);
    try {
        execSync(`sips -Z ${MAX_DIMENSION} -s format jpeg "${sourceImagePath}" --out "${destImagePath}"`);
    } catch (error) {
        console.error(`Error processing image ${file}:`, error);
        return; // Skip to next file
    }

    // --- Metadata Extraction ---
    let geo = "0, 0";
    let place = "City, Country";

    try {
        const latOutput = execSync(`mdls -name kMDItemLatitude -raw "${sourceImagePath}"`).toString();
        const lonOutput = execSync(`mdls -name kMDItemLongitude -raw "${sourceImagePath}"`).toString();
        const lat = parseFloat(latOutput);
        const lon = parseFloat(lonOutput);

        if (!isNaN(lat) && !isNaN(lon)) {
            geo = `${lat}, ${lon}`;
            console.log(`  Found GPS: ${geo}`);

            // Reverse geocode using OpenStreetMap
            try {
                const agent = "GeminiCLI/1.0 (https://gemini.google.com/)";
                const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}`;
                const geoResponse = execSync(`curl -s -A "${agent}" "${url}"`).toString();
                const geoJson = JSON.parse(geoResponse);
                if (geoJson.address) {
                    const city = geoJson.address.city || geoJson.address.town || geoJson.address.village || '';
                    const country = geoJson.address.country || '';
                    if (city && country) {
                        place = `${city}, ${country}`;
                        console.log(`  Found Place: ${place}`);
                    }
                }
            } catch (geoError) {
                console.warn(`  Warning: Could not reverse geocode for ${file}.`);
            }
        }
    } catch (gpsError) {
        console.warn(`  Warning: No GPS data found for ${file}.`);
    }

    const tag = "tag";
    const alt = "A photo of...";
    const imagePath = `./images/${newImageName}`;

    if (GALLERY_TYPE === 'fonts') {
        const content = `---\npubDate: ${pubDate}\nimage:\n    file: "${imagePath}"\n    alt: "${alt}"\ngeo: "${geo}"\nplace: "${place}"\ntag: "${tag}"\n---\n`;
        fs.writeFileSync(path.join(targetDir, `${newBaseName}.md`), content);
    } else { // streetart
        const content = {
            pubDate,
            image: {
                file: imagePath,
                alt
            },
            geo,
            place,
            tag
        };
        fs.writeFileSync(path.join(targetDir, `${newBaseName}.json`), JSON.stringify(content, null, 2));
    }

    // Move the original file to the processed directory
    const processedImagePath = path.join(PROCESSED_DIR, file);
    fs.renameSync(sourceImagePath, processedImagePath);
});

console.log("\nDone!");
console.log(`${filesToProcess.length} images processed and added to the "${GALLERY_TYPE}" gallery.`);
console.log("Next step: Open the new files and update the placeholder metadata.");
