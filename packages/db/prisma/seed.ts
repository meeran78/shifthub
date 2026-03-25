import { prisma } from "../src/index.js";

const sites = [
  { name: "HDH - Forest", colorHex: "#2563eb", sortOrder: 1 },
  { name: "HDH - Parham", colorHex: "#7c3aed", sortOrder: 2 },
  { name: "Chippenham", colorHex: "#059669", sortOrder: 3 },
  { name: "Johnston-Willis", colorHex: "#d97706", sortOrder: 4 },
  { name: "VEG", colorHex: "#db2777", sortOrder: 5 },
  { name: "WCE", colorHex: "#0891b2", sortOrder: 6 },
  { name: "Moorefield", colorHex: "#4f46e5", sortOrder: 7 },
  { name: "Wadsworth", colorHex: "#65a30d", sortOrder: 8 },
  { name: "West Broad", colorHex: "#ea580c", sortOrder: 9 },
  { name: "MRMC", colorHex: "#0d9488", sortOrder: 10 },
];

async function main() {
  await prisma.orgSettings.upsert({
    where: { id: "default" },
    create: { id: "default" },
    update: {},
  });

  for (const s of sites) {
    await prisma.site.upsert({
      where: { name: s.name },
      create: s,
      update: { colorHex: s.colorHex, sortOrder: s.sortOrder },
    });
  }

  console.log("Seeded sites and org settings.");
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    prisma.$disconnect();
    process.exit(1);
  });
