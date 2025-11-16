const { Octokit } = require("@octokit/rest");
const fs = require("fs");
const path = require("path");

async function downloadRepo() {
  const octokit = new Octokit();
  
  try {
    // Get repository tree
    const { data: tree } = await octokit.rest.git.getTree({
      owner: "bryandebourbon",
      repo: "eMusicReader",
      tree_sha: "main",
      recursive: true
    });
    
    console.log("Downloading files from eMusicReader repository...");
    
    for (const item of tree.tree) {
      if (item.type === "blob") {
        const { data: blob } = await octokit.rest.git.getBlob({
          owner: "bryandebourbon",
          repo: "eMusicReader",
          file_sha: item.sha
        });
        
        const dir = path.dirname(item.path);
        if (dir !== "." && !fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        
        const content = Buffer.from(blob.content, blob.encoding);
        fs.writeFileSync(item.path, content);
        console.log(`Downloaded: ${item.path}`);
      }
    }
    
    console.log("Repository downloaded successfully!");
  } catch (error) {
    console.error("Error:", error.message);
    process.exit(1);
  }
}

downloadRepo();
