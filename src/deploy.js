import { config } from "dotenv";
import https from "node:https";

config();

async function pveRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    try {
      const headers = {
        Authorization: process.env.PVE_API_TOKEN,
      };

      const bodyStr = body ? JSON.stringify(body) : null;

      if (body) {
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = Buffer.byteLength(bodyStr);
      }

      const options = {
        hostname: process.env.PVE_HOST,
        port: process.env.PVE_PORT,
        path,
        method,
        headers,
        body: body ? body : null,
        // Proxmox certificate issue workaround
        rejectUnauthorized: false,
      };

      const request = https.request(options, (res) => resolve(res));

      if (body) request.write(bodyStr);
      request.end();
    } catch (error) {
      reject(error);
    }
  });
}

async function getJson(response) {
  return new Promise((resolve, reject) => {
    try {
      const chunks = [];
      response.on("data", (it) => chunks.push(it));
      response.on("end", () => {
        const raw = chunks.join("");
        const json = JSON.parse(raw);

        // Errors are returned as { message, errors }
        if ("errors" in json || "message" in json) {
          reject(new Error(raw));
        } else {
          resolve(json);
        }
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function pveJsonRequest(method, path, body) {
  return pveRequest(method, path, body).then((it) => getJson(it));
}

async function getNextId() {
  return pveJsonRequest("GET", "/api2/json/cluster/nextid");
}

async function getRelevantResources() {
  // Returns LXC and QEMU instances
  return pveJsonRequest("GET", "/api2/json/cluster/resources?type=vm");
}

async function getLxcInterfaces(vmid) {
  return pveJsonRequest(
    "GET",
    `/api2/json/nodes/${process.env.PVE_NODE_NAME}/lxc/${vmid}/interfaces`,
  );
}

async function getQemuConfig(vmid) {
  return pveJsonRequest(
    "GET",
    `/api2/json/nodes/${process.env.PVE_NODE_NAME}/qemu/${vmid}/config`,
  );
}

async function cloneTemplate(newId, name) {
  return pveJsonRequest(
    "POST",
    `/api2/json/nodes/${process.env.PVE_NODE_NAME}/qemu/${process.env.TEMPLATE_ID}/clone?newid=${newId}&name=${name}`,
  );
}

async function resizeVm(vmId, size) {
  return pveJsonRequest(
    "PUT",
    `/api2/json/nodes/${process.env.PVE_NODE_NAME}/qemu/${vmId}/resize?disk=scsi0&size=${encodeURIComponent(size)}`,
  );
}

async function configureVm(vmId, cidr, name) {
  const config = {
    name,
    searchdomain: name,
    ipconfig0: `ip=${cidr},gw=10.0.0.1`,
    cicustom: "user=local:snippets/mattermost-setup.yaml",
    onboot: 1,
  };

  return pveJsonRequest(
    "PUT",
    `/api2/json/nodes/${process.env.PVE_NODE_NAME}/qemu/${vmId}/config`,
    config,
  );
}

async function startVm(vmId) {
  return pveJsonRequest(
    "POST",
    `/api2/json/nodes/${process.env.PVE_NODE_NAME}/qemu/${vmId}/status/start`,
  );
}

async function extractLxcIp(vmId) {
  const { data: interfaces } = await getLxcInterfaces(vmId);
  const iface = interfaces.find((it) => it.name === "eth0");

  return iface?.inet?.split("/")[0];
}

async function extractQemuIp(vmId) {
  const {
    data: { ipconfig0 },
  } = await getQemuConfig(vmId);
  // Format: ip=<cidr>,gw=<gwip>
  const ip = ipconfig0?.split(",")[0];
  return ip?.substring(3)?.split("/")[0];
}

async function collectIps() {
  const { data: resources } = await getRelevantResources();

  const ips = await Promise.all(
    resources.map((it) =>
      it.type === "lxc" ? extractLxcIp(it.vmid) : extractQemuIp(it.vmid),
    ),
  );

  // Dedupe values
  return new Set(ips);
}

function ipToInt(ip) {
  const octets = ip
    .split(".")
    .map((it) => Number.parseInt(it))
    .filter((it) => !Number.isNaN(it));

  if (octets.length !== 4) {
    throw new Error(`Illegal IPv4 string: ${ip}`);
  }

  let result = 0;
  result |= octets[0] << 24;
  result |= octets[1] << 16;
  result |= octets[2] << 8;
  result |= octets[3];

  return result;
}

function intToIp(int) {
  const mask = 0xff;
  const octets = [
    int >>> 24,
    mask & (int >>> 16),
    mask & (int >>> 8),
    mask & int,
  ];

  return octets.join(".");
}

function calculateNextIp(ips) {
  const ints = ips.map((it) => ipToInt(it));
  let ip = null;
  for (
    let i = ipToInt(process.env.FIRST_ASSIGNABLE_IP);
    i < ipToInt(process.env.LAST_ASSIGNABLE_IP);
    i++
  ) {
    if (!ints.includes(i)) {
      ip = i;
      break;
    }
  }

  if (!ip) throw new Error("All IP addresses are taken!");

  return intToIp(ip);
}

async function run(vmName) {
  console.log(`Retrieving ID for VM "${vmName}"...`);
  const { data: nextId } = await getNextId();
  console.log(`Assigning ID '${nextId}' to the new VM.`);

  console.log("Gathering IP addresses already in use...");
  const ips = await collectIps();
  console.log(ips);

  console.log("Calculating IP address...");
  const nextIp = calculateNextIp([...ips]);
  console.log(`Assigning IP '${nextIp}' to the new VM.`);

  console.log("Cloning VM...");
  await cloneTemplate(nextId, vmName);
  console.log("Resizing VM disk...");
  await resizeVm(nextId, "+15G");
  console.log("Applying VM configuration...");
  await configureVm(nextId, `${nextIp}/24`, vmName);

  console.log("VM has been cloned successfully, starting...");
  await startVm(nextId);
  console.log("Done!");
}

async function main() {
  const [_node, _script, vmName] = process.argv;
  if (!vmName) {
    console.error("You need to provide a VM name.");
    return;
  }

  await run(vmName);
}

main().catch((err) => console.error(err));
