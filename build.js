const fs = require("fs-extra");

const files = [
  "./dist/widget-element/runtime.js",
  "./dist/widget-element/polyfills.js",
  "./dist/widget-element/main.js",
];

const build = async () => {
  await fs.ensureDir("./build");
  await fs.emptyDir("./build");

  for (const file of files) {
    const exists = await fs.pathExists(file);
    if (exists) {
      await fs.copyFile(file, `./build/${file.split("/").pop()}`);
    }
  }

  const existingFiles = files.filter((file) => fs.existsSync(file));
  const contents = await Promise.all(
    existingFiles.map((file) => fs.readFile(file, "utf8"))
  );
  await fs.writeFile("./build/widget-element.js", contents.join("\n"), "utf8");

  if (await fs.pathExists("./dist/widget-element/styles.css")) {
    await fs.copyFile("./dist/widget-element/styles.css", "./build/styles.css");
  }

  if (await fs.pathExists("./dist/widget-element/favicon.ico")) {
    await fs.copyFile("./dist/widget-element/favicon.ico", "./build/favicon.ico");
  }

  await fs.ensureDir("./template");
  if (await fs.pathExists("./template/index.html")) {
    await fs.copyFile("./template/index.html", "./build/index.html");
  }
  if (await fs.pathExists("./template/widget-loader.js")) {
    await fs.copyFile("./template/widget-loader.js", "./build/widget-loader.js");
  }
};

build()
  .then(() => console.log("Build complete"))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
