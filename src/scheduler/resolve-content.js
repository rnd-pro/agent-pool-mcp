import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

async function resolve() {
  const arg = process.argv[2];
  if (!arg) {
    console.error('No source argument provided');
    process.exit(1);
  }

  let src;
  try {
    src = JSON.parse(arg);
  } catch (e) {
    console.error('Invalid JSON source argument');
    process.exit(1);
  }

  const __dirname = dirname(fileURLToPath(import.meta.url));
  
  try {
    const { buildTagIndex, searchByTags } = await import(join(__dirname, '../tools/workflow-index.js'));
    const workflowsDir = join(process.cwd(), '.agent-portal', 'workflows');
    const { nodes, tagIndex } = buildTagIndex(workflowsDir);

    const { getTrackedFiles } = await import(join(__dirname, '../tools/file-tracker.js'));
    const cwd = process.cwd();
    const activeFiles = getTrackedFiles(cwd);
    
    src.variables = src.variables || {};
    if (activeFiles.length > 0 && !src.variables.active_files) {
      src.variables.active_files = activeFiles.map(f => `- ${f}`).join('\n');
    }

    const applyVariables = (text, vars) => {
      if (!vars) return text;
      return text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) => {
        return vars[key] !== undefined ? vars[key] : match;
      });
    };

    if (src.tags) {
      const matched = searchByTags(nodes, tagIndex, src.tags);
      if (matched.length === 1) {
        console.log(applyVariables(matched[0].body, src.variables));
      } else if (matched.length > 1) {
        console.log("MULTIPLE MATCHES FOUND. Focus on one:\n" + matched.map(m => "- " + m.id + ": " + (m.meta.description || m.meta.name)).join('\n'));
      } else {
        console.log("NO MATCHES FOUND FOR TAGS: " + src.tags.join(', '));
      }
    } else if (src.nodeId) {
      const n = nodes.get(src.nodeId);
      if (n) {
        console.log(applyVariables(n.body, src.variables));
      } else {
        console.log("NODE NOT FOUND: " + src.nodeId);
      }
    } else {
      console.log("INVALID CONTENT SOURCE: must specify tags or nodeId");
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}

resolve();
