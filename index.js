import blessed from "blessed";
import chalk from "chalk";
import figlet from "figlet";
import { ethers } from "ethers";
import fs from "fs";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import axios from "axios";

const RPC_URL = "https://testnet-rpc.xoscan.io/";
const CONFIG_FILE = "config.json";
const WXOS_ADDRESS = "0x0AAB67cf6F2e99847b9A95DeC950B250D648c1BB";
const USDC_ADDRESS = "0xb2C1C007421f0Eb5f4B3b3F38723C309Bb208d7d";
const BNB_ADDRESS = "0x83DFbE02dc1B1Db11bc13a8Fc7fd011E2dBbd7c0";
const SWAP_ROUTER_ADDRESS = "0xdc7D6b58c89A554b3FDC4B5B10De9b4DbF39FB40";
const TOKEN_CREATION_ROUTER_ADDRESS = "0xEBB7781329f101F0FDBC90A3B6f211082863884B";
const CONTRACT_DEPLOY_ROUTER_ADDRESS = "0x45aE5Fb74828FDf9fD708C7491dC84543ec8A87e";
const CHAIN_ID = 1267;
const isDebug = false;

const swapTokens = [
  { name: "USDC", address: USDC_ADDRESS, decimals: 18 },
  { name: "BNB", address: BNB_ADDRESS, decimals: 18 }
];

let walletInfo = {
  address: "N/A",
  balanceXOS: "0.0000",
  balanceUSDC: "0.0000",
  balanceBNB: "0.000000",
  activeAccount: "N/A"
};
let transactionLogs = [];
let activityRunning = false;
let isCycleRunning = false;
let shouldStop = false;
let dailyActivityInterval = null;
let accounts = [];
let proxies = [];
let selectedWalletIndex = 0;
let loadingSpinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const borderBlinkColors = ["cyan", "blue", "magenta", "red", "yellow", "green"];
let borderBlinkIndex = 0;
let blinkCounter = 0;
let spinnerIndex = 0;
let nonceTracker = {};
let hasLoggedSleepInterrupt = false;
let isHeaderRendered = false;
let activeProcesses = 0;

let dailyActivityConfig = {
  swapRepetitions: 1,
  xosSwapRange: { min: 0.001, max: 0.004 },
  tokenSwapRanges: {
    USDC: { min: 0.02, max: 0.045 },
    BNB: { min: 0.0003, max: 0.00075 }
  }
};

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)"
];

const SWAP_ROUTER_ABI = [
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut)",
  "function multicall(uint256 deadline, bytes[] data) returns (bytes[] results)",
  "function unwrapWETH9(uint256 amountMinimum, address recipient) returns (uint256)"
];

const TOKEN_CREATION_ABI = [
  "function createToken(string name, string symbol, uint8 decimals, uint256 totalSupply) payable returns (address)"
];

const CONTRACT_DEPLOY_ABI = [
  "function 0x8ffc0e4b(bytes varg0) public payable returns (address)"
];

const userAgents = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edge/119.0.0.0",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (Android 13; Mobile; rv:109.0) Gecko/109.0 Firefox/109.0"
];

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, "utf8");
      const config = JSON.parse(data);
      dailyActivityConfig.swapRepetitions = Number(config.swapRepetitions) || 1;
      dailyActivityConfig.xosSwapRange.min = Number(config.xosSwapRange?.min) || 0.001;
      dailyActivityConfig.xosSwapRange.max = Number(config.xosSwapRange?.max) || 0.004;
      dailyActivityConfig.tokenSwapRanges.USDC.min = Number(config.tokenSwapRanges?.USDC?.min) || 0.02;
      dailyActivityConfig.tokenSwapRanges.USDC.max = Number(config.tokenSwapRanges?.USDC?.max) || 0.045;
      dailyActivityConfig.tokenSwapRanges.BNB.min = Number(config.tokenSwapRanges?.BNB?.min) || 0.0003;
      dailyActivityConfig.tokenSwapRanges.BNB.max = Number(config.tokenSwapRanges?.BNB?.max) || 0.00075;
    } else {
      addLog("No config file found, using default settings.", "info");
    }
  } catch (error) {
    addLog(`Failed to load config: ${error.message}`, "error");
  }
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(dailyActivityConfig, null, 2));
    addLog("Configuration saved successfully.", "success");
  } catch (error) {
    addLog(`Failed to save config: ${error.message}`, "error");
  }
}

async function makeJsonRpcCall(method, params) {
  try {
    const proxyUrl = proxies[selectedWalletIndex % proxies.length] || null;
    const agent = createAgent(proxyUrl);
    const response = await axios.post(RPC_URL, {
      jsonrpc: "2.0",
      method,
      params
    }, {
      headers: { "Content-Type": "application/json" },
      httpsAgent: agent
    });
    const data = response.data;
    if (data.error) {
      throw new Error(`RPC Error: ${data.error.message} (code: ${data.error.code})`);
    }
    return data.result;
  } catch (error) {
    addLog(`JSON-RPC call failed (${method}): ${error.message}`, "error");
    throw error;
  }
}

process.on("unhandledRejection", (reason) => {
  addLog(`Unhandled Rejection: ${reason.message || reason}`, "error");
});

process.on("uncaughtException", (error) => {
  addLog(`Uncaught Exception: ${error.message}\n${error.stack}`, "error");
  process.exit(1);
});

function getShortAddress(address) {
  return address ? address.slice(0, 6) + "..." + address.slice(-4) : "N/A";
}

function addLog(message, type = "info") {
  if (type === "debug" && !isDebug) return;
  const timestamp = new Date().toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta" });
  let coloredMessage;
  switch (type) {
    case "error":
      coloredMessage = chalk.redBright(message);
      break;
    case "success":
      coloredMessage = chalk.greenBright(message);
      break;
    case "wait":
      coloredMessage = chalk.yellowBright(message);
      break;
    case "info":
      coloredMessage = chalk.whiteBright(message);
      break;
    case "delay":
      coloredMessage = chalk.cyanBright(message);
      break;
    case "debug":
      coloredMessage = chalk.blueBright(message);
      break;
    default:
      coloredMessage = chalk.white(message);
  }
  const logMessage = `[${timestamp}] ${coloredMessage}`;
  transactionLogs.push(logMessage);
  updateLogs();
}

function getShortHash(hash) {
  return hash.slice(0, 6) + "..." + hash.slice(-4);
}

function clearTransactionLogs() {
  transactionLogs = [];
  logBox.setContent('');
  logBox.scrollTo(0);
  addLog("Transaction logs cleared.", "success");
}

function loadAccounts() {
  try {
    const data = fs.readFileSync("account.json", "utf8");
    accounts = JSON.parse(data);
    if (!Array.isArray(accounts) || accounts.length === 0) {
      throw new Error("No accounts found in account.json");
    }
    accounts.forEach((account, index) => {
      if (!account.privateKey || !account.token) {
        throw new Error(`Account at index ${index} missing privateKey or token`);
      }
    });
    addLog(`Loaded ${accounts.length} accounts from account.json`, "success");
  } catch (error) {
    addLog(`Failed to load accounts: ${error.message}`, "error");
    accounts = [];
  }
}

function loadProxies() {
  try {
    if (fs.existsSync("proxy.txt")) {
      const data = fs.readFileSync("proxy.txt", "utf8");
      proxies = data.split("\n").map(proxy => proxy.trim()).filter(proxy => proxy);
      if (proxies.length === 0) throw new Error("No proxies found in proxy.txt");
      addLog(`Loaded ${proxies.length} proxies from proxy.txt`, "success");
    } else {
      addLog("No proxy.txt found, running without proxies.", "info");
    }
  } catch (error) {
    addLog(`Failed to load proxies: ${error.message}`, "info");
    proxies = [];
  }
}

function createAgent(proxyUrl) {
  if (!proxyUrl) return null;
  if (proxyUrl.startsWith("socks")) {
    return new SocksProxyAgent(proxyUrl);
  } else {
    return new HttpsProxyAgent(proxyUrl);
  }
}

function getProviderWithProxy(proxyUrl, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const agent = createAgent(proxyUrl);
      const fetchOptions = agent ? { agent } : {};
      const provider = new ethers.JsonRpcProvider(RPC_URL, { chainId: CHAIN_ID, name: "XOS" }, { fetchOptions });
      provider.getNetwork().then(network => {
        if (Number(network.chainId) !== CHAIN_ID) {
          throw new Error(`Network chain ID mismatch: expected ${CHAIN_ID}, got ${network.chainId}`);
        }
      }).catch(err => {
        throw err;
      });
      return provider;
    } catch (error) {
      addLog(`Attempt ${attempt}/${maxRetries} failed to initialize provider: ${error.message}`, "error");
      if (attempt < maxRetries) sleep(1000);
    }
  }
  try {
    addLog(`Proxy failed, falling back to direct connection`, "warn");
    const provider = new ethers.JsonRpcProvider(RPC_URL, { chainId: CHAIN_ID, name: "XOS" });
    provider.getNetwork().then(network => {
      if (Number(network.chainId) !== CHAIN_ID) {
        throw new Error(`Network chain ID mismatch: expected ${CHAIN_ID}, got ${network.chainId}`);
      }
    }).catch(err => {
      throw err;
    });
    return provider;
  } catch (error) {
    addLog(`Direct connection failed: ${error.message}`, "error");
    throw error;
  }
}

async function sleep(ms) {
  if (shouldStop) {
    if (!hasLoggedSleepInterrupt) {
      addLog("Process stopped successfully.", "info");
      hasLoggedSleepInterrupt = true;
    }
    return;
  }
  activeProcesses++;
  try {
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve();
      }, ms);
      const checkStop = setInterval(() => {
        if (shouldStop) {
          clearTimeout(timeout);
          clearInterval(checkStop);
          if (!hasLoggedSleepInterrupt) {
            addLog("Process stopped.", "info");
            hasLoggedSleepInterrupt = true;
          }
          resolve();
        }
      }, 100);
    });
  } catch (error) {
    addLog(`Sleep error: ${error.message}`, "error");
  } finally {
    activeProcesses = Math.max(0, activeProcesses - 1);
  }
}

async function updateWalletData() {
  const walletDataPromises = accounts.map(async (account, i) => {
    try {
      const proxyUrl = proxies[i % proxies.length] || null;
      const provider = getProviderWithProxy(proxyUrl);
      const wallet = new ethers.Wallet(account.privateKey, provider);

      const xosBalance = await provider.getBalance(wallet.address);
      const formattedXOS = Number(ethers.formatEther(xosBalance)).toFixed(4);

      const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
      let usdcDecimals = 6;
      try {
        usdcDecimals = await usdcContract.decimals();
      } catch (error) {
        addLog(`Failed to fetch USDC decimals for account #${i + 1}: ${error.message}, assuming 6`, "error");
      }
      const usdcBalance = await usdcContract.balanceOf(wallet.address);
      const formattedUSDC = Number(ethers.formatUnits(usdcBalance, usdcDecimals)).toFixed(4);

      const bnbContract = new ethers.Contract(BNB_ADDRESS, ERC20_ABI, provider);
      const bnbBalance = await bnbContract.balanceOf(wallet.address);
      const formattedBNB = Number(ethers.formatUnits(bnbBalance, 18)).toFixed(6);

      const formattedEntry = `${i === selectedWalletIndex ? "→ " : "  "}${chalk.bold.magentaBright(getShortAddress(wallet.address))}    ${chalk.bold.cyanBright(formattedXOS.padEnd(8))}   ${chalk.bold.cyanBright(formattedUSDC.padEnd(8))}   ${chalk.bold.cyanBright(formattedBNB.padEnd(8))}`;

      if (i === selectedWalletIndex) {
        walletInfo.address = wallet.address;
        walletInfo.activeAccount = `Account ${i + 1}`;
        walletInfo.balanceXOS = formattedXOS;
        walletInfo.balanceUSDC = formattedUSDC;
        walletInfo.balanceBNB = formattedBNB;
      }
      return formattedEntry;
    } catch (error) {
      addLog(`Failed to fetch wallet data for account #${i + 1}: ${error.message}`, "error");
      return `${i === selectedWalletIndex ? "→ " : "  "}N/A 0.0000 0.0000 0.000000`;
    }
  });
  try {
    const walletData = await Promise.all(walletDataPromises);
    addLog("Wallet data updated.", "success");
    return walletData;
  } catch (error) {
    addLog(`Wallet data update failed: ${error.message}`, "error");
    return [];
  }
}

async function getNextNonce(provider, walletAddress) {
  if (shouldStop) {
    addLog("Nonce fetching stopped due to stop request.", "info");
    throw new Error("Process stopped");
  }
  if (!ethers.isAddress(walletAddress)) {
    addLog(`Invalid wallet address: ${walletAddress}`, "error");
    throw new Error("Invalid wallet address");
  }
  try {
    const pendingNonce = await provider.getTransactionCount(walletAddress, "pending");
    const lastUsedNonce = nonceTracker[walletAddress] || pendingNonce - 1;
    const nextNonce = Math.max(pendingNonce, lastUsedNonce + 1);
    nonceTracker[walletAddress] = nextNonce;
    addLog(`Debug: Fetched nonce ${nextNonce} for ${getShortAddress(walletAddress)}`, "debug");
    return nextNonce;
  } catch (error) {
    addLog(`Failed to fetch nonce for ${getShortAddress(walletAddress)}: ${error.message}`, "error");
    throw error;
  }
}

async function estimateTransactionCost(gasLimit) {
  try {
    const gasPrice = await provider.getFeeData().maxFeePerGas || ethers.parseUnits("1", "gwei");
    return gasPrice * BigInt(gasLimit);
  } catch (error) {
    addLog(`Failed to estimate gas: ${error.message}. Using default 1 gwei.`, "debug");
    return ethers.parseUnits("1", "gwei") * BigInt(gasLimit);
  }
}

async function performSwap(wallet, token, direction, amount) {
  const tokenContract = new ethers.Contract(token.address, ERC20_ABI, wallet);
  const swapRouterContract = new ethers.Contract(SWAP_ROUTER_ADDRESS, SWAP_ROUTER_ABI, wallet);
  const decimals = direction === "XOS_TO_TOKEN" ? 18 : token.decimals;
  const amountWei = ethers.parseUnits(amount.toString(), decimals);
  const fee = 500;
  const deadline = Math.floor(Date.now() / 1000) + 60 * 20;

  try {
    if (direction === "XOS_TO_TOKEN") {
      const xosBalance = await wallet.provider.getBalance(wallet.address);
      const estimatedGasCost = await estimateTransactionCost(150000);
      const totalRequired = amountWei + estimatedGasCost;
      if (xosBalance < totalRequired) {
        throw new Error(`Insufficient XOS balance: ${ethers.formatEther(xosBalance)} < ${ethers.formatEther(totalRequired)}`);
      }
      const swapParams = {
        tokenIn: WXOS_ADDRESS,
        tokenOut: token.address,
        fee,
        recipient: wallet.address,
        amountIn: amountWei,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0
      };
      const swapInterface = new ethers.Interface(SWAP_ROUTER_ABI);
      const encodedData = swapInterface.encodeFunctionData('exactInputSingle', [swapParams]);
      const multicallData = [encodedData];
      const tx = {
        to: SWAP_ROUTER_ADDRESS,
        data: swapRouterContract.interface.encodeFunctionData('multicall', [deadline, multicallData]),
        value: amountWei,
        gasLimit: 150000,
        chainId: CHAIN_ID,
        nonce: await getNextNonce(wallet.provider, wallet.address)
      };
      const sentTx = await wallet.sendTransaction(tx);
      addLog(`Swap transaction sent: ${getShortHash(sentTx.hash)}`, "info");
      const receipt = await sentTx.wait();
      if (receipt.status === 0) {
        throw new Error("Transaction reverted");
      }
      addLog(`Swap successful: ${amount} XOS to ${token.name}`, "success");
    } else {
      const tokenBalance = await tokenContract.balanceOf(wallet.address);
      if (tokenBalance < amountWei) {
        throw new Error(`Insufficient ${token.name} balance: ${ethers.formatUnits(tokenBalance, token.decimals)} < ${amount}`);
      }
      const allowance = await tokenContract.allowance(wallet.address, SWAP_ROUTER_ADDRESS);
      if (allowance < amountWei) {
        addLog(`Approving router to spend ${amount} ${token.name}`, "info");
        const approveTx = await tokenContract.approve(SWAP_ROUTER_ADDRESS, amountWei, {
          gasLimit: 100000,
          nonce: await getNextNonce(wallet.provider, wallet.address)
        });
        const approveReceipt = await approveTx.wait();
        if (approveReceipt.status === 0) {
          throw new Error("Approval transaction reverted");
        }
        addLog("Approval successful", "success");
      }
      const swapParams = {
        tokenIn: token.address,
        tokenOut: WXOS_ADDRESS,
        fee,
        recipient: SWAP_ROUTER_ADDRESS,
        amountIn: amountWei,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0
      };
      const unwrapParams = { amountMinimum: 0, recipient: wallet.address };
      const swapInterface = new ethers.Interface(SWAP_ROUTER_ABI);
      const encodedSwapData = swapInterface.encodeFunctionData('exactInputSingle', [swapParams]);
      const encodedUnwrapData = swapInterface.encodeFunctionData('unwrapWETH9', [unwrapParams.amountMinimum, unwrapParams.recipient]);
      const multicallData = [encodedSwapData, encodedUnwrapData];
      const tx = {
        to: SWAP_ROUTER_ADDRESS,
        data: swapRouterContract.interface.encodeFunctionData('multicall', [deadline, multicallData]),
        value: 0,
        gasLimit: 250000,
        chainId: CHAIN_ID,
        nonce: await getNextNonce(wallet.provider, wallet.address)
      };
      const sentTx = await wallet.sendTransaction(tx);
      addLog(`Swap transaction sent: ${getShortHash(sentTx.hash)}`, "info");
      const receipt = await sentTx.wait();
      if (receipt.status === 0) {
        throw new Error("Transaction reverted");
      }
      addLog(`Swap successful: ${amount} ${token.name} to XOS`, "success");
    }
    await updateWallets();
  } catch (error) {
    addLog(`Swap failed: ${error.message}`, "error");
    throw error;
  }
}

async function createToken(name, symbol, supply) {
  const decimals = 18;
  const creationFee = ethers.parseUnits("0.001", 18);
  let supplyBigInt;

  try {
    const supplyNumber = Number(supply);
    if (isNaN(supplyNumber) || supplyNumber <= 0) {
      throw new Error("Total supply must be a positive number");
    }
    if (supplyNumber > 1000000000) {
      throw new Error("Total supply too large, maximum is 1,000,000,000 tokens");
    }
    supplyBigInt = BigInt(supplyNumber);

    const provider = getProviderWithProxy(proxies[selectedWalletIndex % proxies.length] || null);
    const wallet = new ethers.Wallet(accounts[selectedWalletIndex].privateKey, provider);
    const contract = new ethers.Contract(TOKEN_CREATION_ROUTER_ADDRESS, TOKEN_CREATION_ABI, wallet);

    const xosBalance = await provider.getBalance(wallet.address);
    const estimatedGasCost = await estimateTransactionCost(1200000);
    const totalRequired = creationFee + estimatedGasCost;
    if (xosBalance < totalRequired) {
      throw new Error(`Insufficient XOS balance: ${ethers.formatEther(xosBalance)} < ${ethers.formatEther(totalRequired)}`);
    }

    addLog(`Creating token: name=${name}, symbol=${symbol}, decimals=${decimals}, supply=${supplyNumber} tokens (${supplyBigInt.toString()} raw)`, "info");

    const nonce = await getNextNonce(provider, wallet.address);

    const tx = await contract.createToken(name, symbol, decimals, supplyBigInt, {
      value: creationFee,
      gasLimit: 1200000,
      nonce: nonce,
      gasPrice: ethers.parseUnits("78.75", "gwei")
    });

    addLog(`Token creation transaction sent: ${getShortHash(tx.hash)}`, "info");

    const receipt = await tx.wait();
    if (receipt.status === 0) {
      throw new Error(`Transaction reverted: ${JSON.stringify(receipt)}`);
    }

    addLog(`Token Created Successfully: ${name} (${symbol}) with supply ${supplyNumber}`, "success");
    await updateWallets();
  } catch (error) {
    addLog(`Token Creation Failed: ${error.message}`, "error");
    throw error;
  }
}

async function deployContract(name, funding) {
  try {
    const provider = getProviderWithProxy(proxies[selectedWalletIndex % proxies.length] || null);
    const wallet = new ethers.Wallet(accounts[selectedWalletIndex].privateKey, provider);

    const fundingWei = ethers.parseUnits(funding.toString(), 18);

    const xosBalance = await provider.getBalance(wallet.address);
    const estimatedGasCost = await estimateTransactionCost(1000000);
    const totalRequired = fundingWei + estimatedGasCost;
    if (xosBalance < totalRequired) {
      throw new Error(`Insufficient XOS balance: ${ethers.formatEther(xosBalance)} < ${ethers.formatEther(totalRequired)}`);
    }

    const contract = new ethers.Contract(
      CONTRACT_DEPLOY_ROUTER_ADDRESS,
      ["function deploymentFee() view returns (uint256)"],
      provider
    );
    const deploymentFee = await contract.deploymentFee();
    if (fundingWei < deploymentFee) {
      throw new Error(`Insufficient funding: ${ethers.formatEther(fundingWei)} < ${ethers.formatEther(deploymentFee)}`);
    }
    addLog(`Deployment fee required: ${ethers.formatEther(deploymentFee)} XOS`, "info");

    if (!name || name.length === 0) {
      throw new Error("Contract name cannot be empty");
    }
    if (name.length > 32) {
      throw new Error(`Contract name too long: ${name.length} characters (max 32)`);
    }

    addLog(`Deploying contract: name=${name}, funding=${funding} XOS`, "info");

    const abiCoder = new ethers.AbiCoder();
    const data = abiCoder.encode(["string"], [name]);
    addLog(`Encoded data: ${data}`, "debug");

    const nonce = await getNextNonce(provider, wallet.address);

    const tx = await wallet.sendTransaction({
      to: CONTRACT_DEPLOY_ROUTER_ADDRESS,
      data: "0x8ffc0e4b" + data.slice(2),
      value: fundingWei,
      gasLimit: 1000000,
      nonce: nonce,
      gasPrice: ethers.parseUnits("78.75", "gwei")
    });

    addLog(`Contract deployment Transaction Sent: ${getShortHash(tx.hash)}`, "info");

    const receipt = await tx.wait();
    if (receipt.status === 0) {
      let revertReason = "Unknown revert reason";
      try {
        const txResponse = await provider.getTransaction(tx.hash);
        const code = await provider.call(
          {
            to: txResponse.to,
            data: txResponse.data,
            value: txResponse.value,
            gasLimit: txResponse.gasLimit,
            gasPrice: txResponse.gasPrice,
          },
          receipt.blockNumber
        );
        revertReason = ethers.utils.toUtf8String(code) || "No revert string provided";
      } catch (error) {
        revertReason = error.reason || error.message || "Failed to retrieve revert reason";
      }
      throw new Error(`Transaction reverted: ${revertReason}`);
    }

    addLog(`Contract Deployed Successfully: ${name}`, "success");
    await updateWallets();
  } catch (error) {
    addLog(`Contract Deployment Failed: ${error.message}`, "error");
    throw error;
  }
}
async function handleTokenCreation(name, symbol, supply) {
  try {
    await createToken(name, symbol, supply);
  } catch (error) {
  }
}

async function handleDeployContract(name, funding) {
  try {
    await deployContract(name, funding);
  } catch (error) {
  }
}

async function performCheckIn(token, proxyUrl) {
  const userAgent = userAgents[Math.floor(Math.random() * userAgents.length)];
  const headers = {
    'accept': 'application/json, text/plain, */*',
    'accept-encoding': 'gzip, deflate, br',
    'accept-language': 'en-GB,en-US;q=0.9,en;q=0.8,id;q=0.7',
    'authorization': `Bearer ${token}`,
    'content-type': 'application/json',
    'origin': 'https://x.ink',
    'priority': 'u=1, i',
    'referer': 'https://x.ink/',
    'sec-ch-ua': '"Chromium";v="134", "Not:A-Brand";v="24", "Opera";v="119"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site',
    'user-agent': userAgent
  };
  const agent = createAgent(proxyUrl);
  try {
    const response = await axios.post('https://api.x.ink/v1/check-in', {}, { headers, httpsAgent: agent });
    if (response.data.success) {
      addLog(`Check-in successful: earned ${response.data.pointsEarned} points, check-in count: ${response.data.check_in_count}`, "success");
    } else {
      const errorMessage = response.data.error || 'No error message';
      if (errorMessage === "Already checked in today") {
        addLog(`Check-in skipped: Already checked in today`, "wait");
      } else {
        addLog(`Check-in failed: ${errorMessage}`, "error");
      }
    }
  } catch (error) {
    const errorMessage = error.response?.data?.error || error.message;
    addLog(`Check-in request failed: ${errorMessage}`, "error");
  }
}

async function runDailyActivity() {
  if (accounts.length === 0) {
    addLog("No valid accounts found.", "error");
    return;
  }
  addLog(`Starting daily activity for all accounts. Auto Swap: ${dailyActivityConfig.swapRepetitions}x`, "info");
  activityRunning = true;
  isCycleRunning = true;
  shouldStop = false;
  hasLoggedSleepInterrupt = false;
  activeProcesses = Math.max(0, activeProcesses);
  updateMenu();
  try {
    for (let accountIndex = 0; accountIndex < accounts.length && !shouldStop; accountIndex++) {
      addLog(`Starting processing for account ${accountIndex + 1}`, "info");
      selectedWalletIndex = accountIndex;
      const proxyUrl = proxies[accountIndex % proxies.length] || null;
      let provider;
      addLog(`Account ${accountIndex + 1}: Using Proxy ${proxyUrl || "none"}`, "info");
      try {
        provider = await getProviderWithProxy(proxyUrl);
        await provider.getNetwork();
      } catch (error) {
        addLog(`Failed to connect to provider for account ${accountIndex + 1}: ${error.message}`, "error");
        continue;
      }
      const wallet = new ethers.Wallet(accounts[accountIndex].privateKey, provider);
      if (!ethers.isAddress(wallet.address)) {
        addLog(`Invalid wallet address for account ${accountIndex + 1}: ${wallet.address}`, "error");
        continue;
      }
      addLog(`Processing account ${accountIndex + 1}: ${getShortAddress(wallet.address)}`, "wait");

      for (let swapCount = 0; swapCount < dailyActivityConfig.swapRepetitions && !shouldStop; swapCount++) {
        const token = swapTokens[Math.floor(Math.random() * swapTokens.length)];
        const direction = Math.random() < 0.5 ? "XOS_TO_TOKEN" : "TOKEN_TO_XOS";
        let amount;
        if (direction === "XOS_TO_TOKEN") {
          amount = (Math.random() * (dailyActivityConfig.xosSwapRange.max - dailyActivityConfig.xosSwapRange.min) + dailyActivityConfig.xosSwapRange.min).toFixed(4);
        } else {
          const tokenRange = dailyActivityConfig.tokenSwapRanges[token.name];
          amount = (Math.random() * (tokenRange.max - tokenRange.min) + tokenRange.min).toFixed(token.name === "USDC" ? 4 : 5);
        }
        addLog(`Account ${accountIndex + 1} - Swap ${swapCount + 1}: ${direction} ${amount} ${direction === "XOS_TO_TOKEN" ? "XOS" : token.name} to ${direction === "XOS_TO_TOKEN" ? token.name : "XOS"}`, "info");
        try {
          await performSwap(wallet, token, direction, amount);
        } catch (error) {
          addLog(`Account ${accountIndex + 1} - Swap ${swapCount + 1}: Failed: ${error.message}`, "error");
        }
        if (swapCount < dailyActivityConfig.swapRepetitions - 1 && !shouldStop) {
          const randomDelay = Math.floor(Math.random() * (60000 - 30000 + 1)) + 30000;
          addLog(`Account ${accountIndex + 1} - Waiting ${Math.floor(randomDelay / 1000)} seconds before next swap...`, "delay");
          await sleep(randomDelay);
        }
      }

      if (!shouldStop) {
        addLog(`Performing daily check-in for account ${accountIndex + 1}`, "info");
        await performCheckIn(accounts[accountIndex].token, proxyUrl);
      }

      if (accountIndex < accounts.length - 1 && !shouldStop) {
        addLog(`Waiting 10 seconds before next account...`, "delay");
        await sleep(10000);
      }
    }
    if (!shouldStop && activeProcesses <= 0) {
      addLog("All accounts processed. Waiting 24 hours for next cycle.", "success");
      dailyActivityInterval = setTimeout(runDailyActivity, 24 * 60 * 60 * 1000);
    }
  } catch (error) {
    addLog(`Daily activity failed: ${error.message}`, "error");
  } finally {
    if (shouldStop) {
      const stopCheckInterval = setInterval(() => {
        if (activeProcesses <= 0) {
          clearInterval(stopCheckInterval);
          if (dailyActivityInterval) {
            clearTimeout(dailyActivityInterval);
            dailyActivityInterval = null;
            addLog("Daily activity interval cleared.", "info");
          }
          activityRunning = false;
          isCycleRunning = false;
          shouldStop = false;
          hasLoggedSleepInterrupt = false;
          activeProcesses = 0;
          addLog("Daily activity stopped successfully.", "success");
          updateMenu();
          updateStatus();
          safeRender();
        } else {
          addLog(`Waiting for ${activeProcesses} processes to complete...`, "info");
        }
      }, 1000);
    } else {
      activityRunning = false;
      isCycleRunning = activeProcesses > 0 || dailyActivityInterval !== null;
      updateMenu();
      updateStatus();
      safeRender();
    }
    nonceTracker = {};
  }
}

const screen = blessed.screen({
  smartCSR: true,
  title: "XOS TESTNET AUTO BOT",
  autoPadding: true,
  fullUnicode: true,
  mouse: true,
  ignoreLocked: ["C-c", "q", "escape"]
});

const headerBox = blessed.box({
  top: 0,
  left: "center",
  width: "100%",
  height: 6,
  tags: true,
  style: { fg: "yellow", bg: "default" }
});

const statusBox = blessed.box({
  left: 0,
  top: 6,
  width: "100%",
  height: 3,
  tags: true,
  border: { type: "line", fg: "cyan" },
  style: { fg: "white", bg: "default", border: { fg: "cyan" } },
  content: "Status: Initializing...",
  padding: { left: 1, right: 1, top: 0, bottom: 0 },
  label: chalk.cyan(" Status "),
  wrap: true
});

const walletBox = blessed.list({
  label: " Wallet Information",
  top: 9,
  left: 0,
  width: "40%",
  height: "35%",
  border: { type: "line", fg: "cyan" },
  style: { border: { fg: "cyan" }, fg: "white", bg: "default", item: { fg: "white" } },
  scrollable: true,
  scrollbar: { bg: "cyan", fg: "black" },
  padding: { left: 1, right: 1, top: 0, bottom: 0 },
  tags: true,
  keys: true,
  vi: true,
  mouse: true,
  content: "Loading wallet data..."
});

const logBox = blessed.log({
  label: " Transaction Logs",
  top: 9,
  left: "41%",
  width: "59%",
  height: "100%-9",
  border: { type: "line" },
  scrollable: true,
  alwaysScroll: true,
  mouse: true,
  tags: true,
  scrollbar: { ch: "│", style: { bg: "cyan", fg: "white" }, track: { bg: "gray" } },
  scrollback: 100,
  smoothScroll: true,
  style: { border: { fg: "magenta" }, bg: "default", fg: "white" },
  padding: { left: 1, right: 1, top: 0, bottom: 0 },
  wrap: true,
  focusable: true,
  keys: true
});

const menuBox = blessed.list({
  label: " Menu ",
  top: "44%",
  left: 0,
  width: "40%",
  height: "56%",
  keys: true,
  vi: true,
  mouse: true,
  border: { type: "line" },
  style: { fg: "white", bg: "default", border: { fg: "red" }, selected: { bg: "magenta", fg: "black" }, item: { fg: "white" } },
  items: isCycleRunning
    ? ["Stop Activity", "Manual Configuration", "Was Labs", "Clear Logs", "Refresh", "Exit"]
    : ["Start Daily Activity", "Manual Configuration", "Was Labs", "Clear Logs", "Refresh", "Exit"],
  padding: { left: 1, top: 1 }
});

const dailyActivitySubMenu = blessed.list({
  label: " Manual Configuration Options ",
  top: "44%",
  left: 0,
  width: "40%",
  height: "56%",
  keys: true,
  vi: true,
  mouse: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "blue" },
    selected: { bg: "blue", fg: "black" },
    item: { fg: "white" }
  },
  items: [
    "Set Swap Repetitions",
    "Set XOS Swap Range",
    "Set USDC Swap Range",
    "Set BNB Swap Range",
    "Back to Main Menu"
  ],
  padding: { left: 1, top: 1 },
  hidden: true
});

const wasLabsSubMenu = blessed.list({
  label: " Was Labs Options ",
  top: "44%",
  left: 0,
  width: "40%",
  height: "56%",
  keys: true,
  vi: true,
  mouse: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "green" },
    selected: { bg: "green", fg: "black" },
    item: { fg: "white" }
  },
  items: [
    "Auto Create Token",
    "Auto Deploy Contract",
    "Clear Logs",
    "Back to Main Menu"
  ],
  padding: { left: 1, top: 1 },
  hidden: true
});

const configForm = blessed.form({
  label: " Enter Configuration Values ",
  top: "center",
  left: "center",
  width: "30%",
  height: "40%",
  keys: true,
  mouse: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "blue" }
  },
  padding: { left: 1, top: 1 },
  hidden: true
});

const minLabel = blessed.text({
  parent: configForm,
  top: 0,
  left: 1,
  content: "Minimum Value:",
  style: { fg: "white" }
});

const maxLabel = blessed.text({
  parent: configForm,
  top: 4,
  left: 1,
  content: "Maximum Value:",
  style: { fg: "white" }
});

const configInput = blessed.textbox({
  parent: configForm,
  top: 1,
  left: 1,
  width: "90%",
  height: 3,
  inputOnFocus: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "white" },
    focus: { border: { fg: "green" } }
  }
});

const configInputMax = blessed.textbox({
  parent: configForm,
  top: 5,
  left: 1,
  width: "90%",
  height: 3,
  inputOnFocus: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "white" },
    focus: { border: { fg: "green" } }
  }
});

const configSubmitButton = blessed.button({
  parent: configForm,
  top: 9,
  left: "center",
  width: 10,
  height: 3,
  content: "Submit",
  align: "center",
  border: { type: "line" },
  clickable: true,
  keys: true,
  mouse: true,
  style: {
    fg: "white",
    bg: "blue",
    border: { fg: "white" },
    hover: { bg: "green" },
    focus: { bg: "green", border: { fg: "yellow" } }
  }
});

const createTokenForm = blessed.form({
  label: " Create Token ",
  top: "center",
  left: "center",
  width: "30%",
  height: "50%",
  keys: true,
  mouse: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "green" }
  },
  padding: { left: 1, top: 1 },
  hidden: true
});

const tokenNameLabel = blessed.text({
  parent: createTokenForm,
  top: 0,
  left: 1,
  content: "Token Name:",
  style: { fg: "white" }
});

const tokenNameInput = blessed.textbox({
  parent: createTokenForm,
  top: 1,
  left: 1,
  width: "90%",
  height: 3,
  inputOnFocus: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "white" },
    focus: { border: { fg: "green" } }
  }
});

const tokenSymbolLabel = blessed.text({
  parent: createTokenForm,
  top: 4,
  left: 1,
  content: "Token Symbol:",
  style: { fg: "white" }
});

const tokenSymbolInput = blessed.textbox({
  parent: createTokenForm,
  top: 5,
  left: 1,
  width: "90%",
  height: 3,
  inputOnFocus: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "white" },
    focus: { border: { fg: "green" } }
  }
});

const tokenSupplyLabel = blessed.text({
  parent: createTokenForm,
  top: 8,
  left: 1,
  content: "Total Supply:",
  style: { fg: "white" }
});

const tokenSupplyInput = blessed.textbox({
  parent: createTokenForm,
  top: 9,
  left: 1,
  width: "90%",
  height: 3,
  inputOnFocus: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "white" },
    focus: { border: { fg: "green" } }
  }
});

const createTokenButton = blessed.button({
  parent: createTokenForm,
  top: 13,
  left: "15%",
  width: 10,
  height: 3,
  content: "Create",
  align: "center",
  border: { type: "line" },
  clickable: true,
  keys: true,
  mouse: true,
  style: {
    fg: "white",
    bg: "blue",
    border: { fg: "white" },
    hover: { bg: "green" },
    focus: { bg: "green", border: { fg: "yellow" } }
  }
});

const cancelTokenButton = blessed.button({
  parent: createTokenForm,
  top: 13,
  left: "50%",
  width: 10,
  height: 3,
  content: "Cancel",
  align: "center",
  border: { type: "line" },
  clickable: true,
  keys: true,
  mouse: true,
  style: {
    fg: "white",
    bg: "red",
    border: { fg: "white" },
    hover: { bg: "darkred" },
    focus: { bg: "darkred", border: { fg: "yellow" } }
  }
});

const deployContractForm = blessed.form({
  label: " Deploy Contract ",
  top: "center",
  left: "center",
  width: "30%",
  height: "50%",
  keys: true,
  mouse: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "green" }
  },
  padding: { left: 1, top: 1 },
  hidden: true
});

const contractNameLabel = blessed.text({
  parent: deployContractForm,
  top: 0,
  left: 1,
  content: "Contract Name:",
  style: { fg: "white" }
});

const contractNameInput = blessed.textbox({
  parent: deployContractForm,
  top: 1,
  left: 1,
  width: "90%",
  height: 3,
  inputOnFocus: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "white" },
    focus: { border: { fg: "green" } }
  }
});

const initialFundingLabel = blessed.text({
  parent: deployContractForm,
  top: 4,
  left: 1,
  content: "Initial Funding (XOS):",
  style: { fg: "white" }
});

const initialFundingInput = blessed.textbox({
  parent: deployContractForm,
  top: 5,
  left: 1,
  width: "90%",
  height: 3,
  inputOnFocus: true,
  border: { type: "line" },
  style: {
    fg: "white",
    bg: "default",
    border: { fg: "white" },
    focus: { border: { fg: "green" } }
  },
  value: "0.001"
});

const deployContractButton = blessed.button({
  parent: deployContractForm,
  top: 9,
  left: "15%",
  width: 10,
  height: 3,
  content: "Deploy",
  align: "center",
  border: { type: "line" },
  clickable: true,
  keys: true,
  mouse: true,
  style: {
    fg: "white",
    bg: "blue",
    border: { fg: "white" },
    hover: { bg: "green" },
    focus: { bg: "green", border: { fg: "yellow" } }
  }
});

const cancelDeployButton = blessed.button({
  parent: deployContractForm,
  top: 9,
  left: "50%",
  width: 10,
  height: 3,
  content: "Cancel",
  align: "center",
  border: { type: "line" },
  clickable: true,
  keys: true,
  mouse: true,
  style: {
    fg: "white",
    bg: "red",
    border: { fg: "white" },
    hover: { bg: "darkred" },
    focus: { bg: "darkred", border: { fg: "yellow" } }
  }
});

screen.append(headerBox);
screen.append(statusBox);
screen.append(walletBox);
screen.append(logBox);
screen.append(menuBox);
screen.append(dailyActivitySubMenu);
screen.append(wasLabsSubMenu);
screen.append(configForm);
screen.append(createTokenForm);
screen.append(deployContractForm);

let renderQueue = [];
let isRendering = false;
function safeRender() {
  renderQueue.push(true);
  if (isRendering) return;
  isRendering = true;
  setTimeout(() => {
    try {
      if (!isHeaderRendered) {
        figlet.text("NT EXHAUST", { font: "ANSI Shadow" }, (err, data) => {
          if (!err) headerBox.setContent(`{center}{bold}{cyan-fg}${data}{/cyan-fg}{/bold}{/center}`);
          isHeaderRendered = true;
        });
      }
      screen.render();
    } catch (error) {
      addLog(`UI rendering error: ${error.message}`, "error");
    }
    renderQueue.shift();
    isRendering = false;
    if (renderQueue.length > 0) safeRender();
  }, 100);
}

function adjustLayout() {
  const screenHeight = screen.height || 24;
  const screenWidth = screen.width || 80;
  headerBox.height = Math.max(6, Math.floor(screenHeight * 0.15));
  statusBox.top = headerBox.height;
  statusBox.height = Math.max(3, Math.floor(screenHeight * 0.07));
  statusBox.width = screenWidth - 2;
  walletBox.top = headerBox.height + statusBox.height;
  walletBox.width = Math.floor(screenWidth * 0.4);
  walletBox.height = Math.floor(screenHeight * 0.35);
  logBox.top = headerBox.height + statusBox.height;
  logBox.left = Math.floor(screenWidth * 0.41);
  logBox.width = screenWidth - walletBox.width - 2;
  logBox.height = screenHeight - (headerBox.height + statusBox.height);
  menuBox.top = headerBox.height + statusBox.height + walletBox.height;
  menuBox.width = Math.floor(screenWidth * 0.4);
  menuBox.height = screenHeight - (headerBox.height + statusBox.height + walletBox.height);

  if (menuBox.top != null) {
    dailyActivitySubMenu.top = menuBox.top;
    dailyActivitySubMenu.width = menuBox.width;
    dailyActivitySubMenu.height = menuBox.height;
    dailyActivitySubMenu.left = menuBox.left;
    wasLabsSubMenu.top = menuBox.top;
    wasLabsSubMenu.width = menuBox.width;
    wasLabsSubMenu.height = menuBox.height;
    wasLabsSubMenu.left = menuBox.left;
    configForm.width = Math.floor(screenWidth * 0.3);
    configForm.height = Math.floor(screenHeight * 0.4);
    createTokenForm.width = Math.floor(screenWidth * 0.3);
    createTokenForm.height = Math.floor(screenHeight * 0.5);
    deployContractForm.width = Math.floor(screenWidth * 0.3);
    deployContractForm.height = Math.floor(screenHeight * 0.5);
  }

  safeRender();
}

function updateStatus() {
  try {
    const isProcessing = activityRunning || (isCycleRunning && dailyActivityInterval !== null);
    const status = activityRunning
      ? `${loadingSpinner[spinnerIndex]} ${chalk.yellowBright("Running")}`
      : isCycleRunning && dailyActivityInterval !== null
      ? `${loadingSpinner[spinnerIndex]} ${chalk.yellowBright("Waiting for next cycle")}`
      : chalk.green("Idle");
    const statusText = `Status: ${status} | Active Account: ${getShortAddress(walletInfo.address)} | Total Accounts: ${accounts.length} | Auto Swap: ${dailyActivityConfig.swapRepetitions}x | XOS TESTNET AUTO BOT`;
    statusBox.setContent(statusText);
    if (isProcessing) {
      if (blinkCounter % 1 === 0) {
        statusBox.style.border.fg = borderBlinkColors[borderBlinkIndex];
        borderBlinkIndex = (borderBlinkIndex + 1) % borderBlinkColors.length;
      }
      blinkCounter++;
    } else {
      statusBox.style.border.fg = "cyan";
    }
    spinnerIndex = (spinnerIndex + 1) % loadingSpinner.length;
    safeRender();
  } catch (error) {
    addLog(`Status update error: ${error.message}`, "error");
  }
}

async function updateWallets() {
  try {
    const walletData = await updateWalletData();
    const header = `${chalk.bold.cyan("  Address").padEnd(12)}           ${chalk.bold.cyan("XOS".padEnd(8))}   ${chalk.bold.cyan("USDC".padEnd(8))}     ${chalk.bold.cyan("BNB".padEnd(8))}`;
    const separator = chalk.gray("-".repeat(60));
    walletBox.setItems([header, separator, ...walletData]);
    walletBox.select(0);
    safeRender();
  } catch (error) {
    addLog(`Failed to update wallet data: ${error.message}`, "error");
  }
}

function updateLogs() {
  try {
    logBox.add(transactionLogs[transactionLogs.length - 1] || chalk.gray("No logs available."));
    logBox.scrollTo(transactionLogs.length);
    safeRender();
  } catch (error) {
    addLog(`Log update failed: ${error.message}`, "error");
  }
}

function updateMenu() {
  try {
    menuBox.setItems(
      isCycleRunning
        ? ["Stop Activity", "Manual Configuration", "Was Labs", "Clear Logs", "Refresh", "Exit"]
        : ["Start Daily Activity", "Manual Configuration", "Was Labs", "Clear Logs", "Refresh", "Exit"]
    );
    safeRender();
  } catch (error) {
    addLog(`Menu update failed: ${error.message}`, "error");
  }
}

const statusInterval = setInterval(updateStatus, 100);

logBox.key(["up"], () => {
  if (screen.focused === logBox) {
    logBox.scroll(-1);
    safeRender();
  }
});

logBox.key(["down"], () => {
  if (screen.focused === logBox) {
    logBox.scroll(1);
    safeRender();
  }
});

logBox.on("click", () => {
  screen.focusPush(logBox);
  logBox.style.border.fg = "yellow";
  menuBox.style.border.fg = "red";
  dailyActivitySubMenu.style.border.fg = "blue";
  wasLabsSubMenu.style.border.fg = "green";
  safeRender();
});

logBox.on("blur", () => {
  logBox.style.border.fg = "magenta";
  safeRender();
});

menuBox.on("select", async (item) => {
  const action = item.getText();
  switch (action) {
    case "Start Daily Activity":
      if (isCycleRunning) {
        addLog("Cycle is already running. Stop the current cycle first.", "error");
      } else {
        await runDailyActivity();
      }
      break;
    case "Stop Activity":
      shouldStop = true;
      if (dailyActivityInterval) {
        clearTimeout(dailyActivityInterval);
        dailyActivityInterval = null;
        addLog("Daily activity interval cleared.", "info");
      }
      addLog("Stopping daily activity. Please wait for running processes to complete.", "info");
      safeRender();
      const stopCheckInterval = setInterval(() => {
        if (activeProcesses <= 0) {
          clearInterval(stopCheckInterval);
          activityRunning = false;
          isCycleRunning = false;
          shouldStop = false;
          hasLoggedSleepInterrupt = false;
          activeProcesses = 0;
          updateMenu();
          updateStatus();
          safeRender();
        } else {
          addLog(`Waiting for ${activeProcesses} processes to complete...`, "info");
          safeRender();
        }
      }, 1000);
      break;
    case "Manual Configuration":
      menuBox.hide();
      dailyActivitySubMenu.show();
      setTimeout(() => {
        if (dailyActivitySubMenu.visible) {
          screen.focusPush(dailyActivitySubMenu);
          dailyActivitySubMenu.style.border.fg = "yellow";
          logBox.style.border.fg = "magenta";
          safeRender();
        }
      }, 100);
      break;
    case "Was Labs":
      menuBox.hide();
      wasLabsSubMenu.show();
      setTimeout(() => {
        if (wasLabsSubMenu.visible) {
          screen.focusPush(wasLabsSubMenu);
          wasLabsSubMenu.style.border.fg = "yellow";
          logBox.style.border.fg = "magenta";
          safeRender();
        }
      }, 100);
      break;
    case "Clear Logs":
      clearTransactionLogs();
      break;
    case "Refresh":
      await updateWallets();
      addLog("Data refreshed.", "success");
      break;
    case "Exit":
      clearInterval(statusInterval);
      process.exit(0);
  }
});

dailyActivitySubMenu.on("select", (item) => {
  const action = item.getText();
  switch (action) {
    case "Set Swap Repetitions":
      configForm.configType = "swapRepetitions";
      configForm.setLabel(" Enter Swap Repetitions ");
      minLabel.hide();
      maxLabel.hide();
      configInput.setValue(dailyActivityConfig.swapRepetitions.toString());
      configInputMax.setValue("");
      configInputMax.hide();
      configForm.show();
      setTimeout(() => {
        if (configForm.visible) {
          screen.focusPush(configInput);
          configInput.clearValue();
          safeRender();
        }
      }, 100);
      break;
    case "Set XOS Swap Range":
      configForm.configType = "xosSwapRange";
      configForm.setLabel(" Enter XOS Swap Range ");
      minLabel.show();
      maxLabel.show();
      configInput.setValue(dailyActivityConfig.xosSwapRange.min.toString());
      configInputMax.setValue(dailyActivityConfig.xosSwapRange.max.toString());
      configInputMax.show();
      configForm.show();
      setTimeout(() => {
        if (configForm.visible) {
          screen.focusPush(configInput);
          configInput.clearValue();
          safeRender();
        }
      }, 100);
      break;
    case "Set USDC Swap Range":
      configForm.configType = "usdcSwapRange";
      configForm.setLabel(" Enter USDC Swap Range ");
      minLabel.show();
      maxLabel.show();
      configInput.setValue(dailyActivityConfig.tokenSwapRanges.USDC.min.toString());
      configInputMax.setValue(dailyActivityConfig.tokenSwapRanges.USDC.max.toString());
      configInputMax.show();
      configForm.show();
      setTimeout(() => {
        if (configForm.visible) {
          screen.focusPush(configInput);
          configInput.clearValue();
          safeRender();
        }
      }, 100);
      break;
    case "Set BNB Swap Range":
      configForm.configType = "bnbSwapRange";
      configForm.setLabel(" Enter BNB Swap Range ");
      minLabel.show();
      maxLabel.show();
      configInput.setValue(dailyActivityConfig.tokenSwapRanges.BNB.min.toString());
      configInputMax.setValue(dailyActivityConfig.tokenSwapRanges.BNB.max.toString());
      configInputMax.show();
      configForm.show();
      setTimeout(() => {
        if (configForm.visible) {
          screen.focusPush(configInput);
          configInput.clearValue();
          safeRender();
        }
      }, 100);
      break;
    case "Back to Main Menu":
      dailyActivitySubMenu.hide();
      menuBox.show();
      setTimeout(() => {
        if (menuBox.visible) {
          screen.focusPush(menuBox);
          menuBox.style.border.fg = "cyan";
          dailyActivitySubMenu.style.border.fg = "blue";
          logBox.style.border.fg = "magenta";
          safeRender();
        }
      }, 100);
      break;
  }
});

wasLabsSubMenu.on("select", async (item) => {
  const action = item.getText();
  switch (action) {
    case "Auto Create Token":
      createTokenForm.show();
      setTimeout(() => {
        if (createTokenForm.visible) {
          screen.focusPush(tokenNameInput);
          tokenNameInput.clearValue();
          tokenSymbolInput.clearValue();
          tokenSupplyInput.clearValue();
          safeRender();
        }
      }, 100);
      break;
    case "Auto Deploy Contract":
      deployContractForm.show();
      setTimeout(() => {
        if (deployContractForm.visible) {
          screen.focusPush(contractNameInput);
          contractNameInput.clearValue();
          initialFundingInput.setValue("0.001");
          safeRender();
        }
      }, 100);
      break;
    case "Clear Logs":
      clearTransactionLogs();
      break;
    case "Back to Main Menu":
      wasLabsSubMenu.hide();
      menuBox.show();
      setTimeout(() => {
        if (menuBox.visible) {
          screen.focusPush(menuBox);
          menuBox.style.border.fg = "cyan";
          wasLabsSubMenu.style.border.fg = "green";
          logBox.style.border.fg = "magenta";
          safeRender();
        }
      }, 100);
      break;
  }
});

let isSubmitting = false;
configForm.on("submit", () => {
  if (isSubmitting) return;
  isSubmitting = true;

  const inputValue = configInput.getValue().trim();
  let value, maxValue;
  try {
    value = parseFloat(inputValue);
    if (["xosSwapRange", "usdcSwapRange", "bnbSwapRange"].includes(configForm.configType)) {
      maxValue = parseFloat(configInputMax.getValue().trim());
      if (isNaN(maxValue) || maxValue <= 0) {
        addLog("Invalid Maximum Value. Please enter a positive number.", "error");
        configInputMax.clearValue();
        screen.focusPush(configInputMax);
        safeRender();
        isSubmitting = false;
        return;
      }
    }
    if (isNaN(value) || value <= 0) {
      addLog("Invalid input. Please enter a positive number.", "error");
      configInput.clearValue();
      screen.focusPush(configInput);
      safeRender();
      isSubmitting = false;
      return;
    }
  } catch (error) {
    addLog(`Invalid format: ${error.message}`, "error");
    configInput.clearValue();
    screen.focusPush(configInput);
    safeRender();
    isSubmitting = false;
    return;
  }

  if (configForm.configType === "swapRepetitions") {
    dailyActivityConfig.swapRepetitions = Math.floor(value);
    addLog(`Swap Repetitions set to ${dailyActivityConfig.swapRepetitions}`, "success");
  } else if (configForm.configType === "xosSwapRange") {
    if (value > maxValue) {
      addLog("Minimum Value cannot be greater than Maximum Value.", "error");
      configInput.clearValue();
      configInputMax.clearValue();
      screen.focusPush(configInput);
      safeRender();
      isSubmitting = false;
      return;
    }
    dailyActivityConfig.xosSwapRange.min = value;
    dailyActivityConfig.xosSwapRange.max = maxValue;
    addLog(`XOS Swap Range set to ${value} - ${maxValue}`, "success");
  } else if (configForm.configType === "usdcSwapRange") {
    if (value > maxValue) {
      addLog("Minimum Value cannot be greater than Maximum Value.", "error");
      configInput.clearValue();
      configInputMax.clearValue();
      screen.focusPush(configInput);
      safeRender();
      isSubmitting = false;
      return;
    }
    dailyActivityConfig.tokenSwapRanges.USDC.min = value;
    dailyActivityConfig.tokenSwapRanges.USDC.max = maxValue;
    addLog(`USDC Swap Range set to ${value} - ${maxValue}`, "success");
  } else if (configForm.configType === "bnbSwapRange") {
    if (value > maxValue) {
      addLog("Minimum Value cannot be greater than Maximum Value.", "error");
      configInput.clearValue();
      configInputMax.clearValue();
      screen.focusPush(configInput);
      safeRender();
      isSubmitting = false;
      return;
    }
    dailyActivityConfig.tokenSwapRanges.BNB.min = value;
    dailyActivityConfig.tokenSwapRanges.BNB.max = maxValue;
    addLog(`BNB Swap Range set to ${value} - ${maxValue}`, "success");
  }
  saveConfig();
  updateStatus();

  configForm.hide();
  dailyActivitySubMenu.show();
  setTimeout(() => {
    if (dailyActivitySubMenu.visible) {
      screen.focusPush(dailyActivitySubMenu);
      dailyActivitySubMenu.style.border.fg = "yellow";
      logBox.style.border.fg = "magenta";
      safeRender();
    }
    isSubmitting = false;
  }, 100);
});

let isCreatingToken = false;
createTokenForm.on("submit", async () => {
  if (isCreatingToken) return;
  isCreatingToken = true;

  const name = tokenNameInput.getValue().trim();
  const symbol = tokenSymbolInput.getValue().trim();
  let supply = tokenSupplyInput.getValue().trim();

  try {
    if (!name || !symbol || !supply) {
      addLog("Semua kolom wajib diisi.", "error");
      if (!name) screen.focusPush(tokenNameInput);
      else if (!symbol) screen.focusPush(tokenSymbolInput);
      else screen.focusPush(tokenSupplyInput);
      safeRender();
      isCreatingToken = false;
      return;
    }

    const supplyNumber = parseFloat(supply);
    if (isNaN(supplyNumber) || supplyNumber <= 0) {
      addLog("Nilai total supply tidak valid. Harap masukkan angka positif.", "error");
      tokenSupplyInput.clearValue();
      screen.focusPush(tokenSupplyInput);
      safeRender();
      isCreatingToken = false;
      return;
    }
    if (supplyNumber > 1000000000) {
      addLog("Total supply terlalu besar. Maksimum adalah 1,000,000,000 token.", "error");
      tokenSupplyInput.clearValue();
      screen.focusPush(tokenSupplyInput);
      safeRender();
      isCreatingToken = false;
      return;
    }

    createTokenForm.hide();
    tokenNameInput.clearValue();
    tokenSymbolInput.clearValue();
    tokenSupplyInput.clearValue();
    wasLabsSubMenu.show();
    setTimeout(() => {
      if (wasLabsSubMenu.visible) {
        screen.focusPush(wasLabsSubMenu);
        wasLabsSubMenu.style.border.fg = "yellow";
        logBox.style.border.fg = "magenta";
        safeRender();
      }
    }, 100);

    handleTokenCreation(name, symbol, supplyNumber);
  } catch (error) {
    addLog(`Kesalahan validasi input token: ${error.message}`, "error");
    isCreatingToken = false;
  }
});

let isDeployingContract = false;
deployContractForm.on("submit", async () => {
  if (isDeployingContract) return;
  isDeployingContract = true;

  const name = contractNameInput.getValue().trim();
  let funding = initialFundingInput.getValue().trim();

  try {
    if (!name || !funding) {
      addLog("Semua kolom wajib diisi.", "error");
      if (!name) screen.focusPush(contractNameInput);
      else screen.focusPush(initialFundingInput);
      safeRender();
      isDeployingContract = false;
      return;
    }

    const fundingNumber = parseFloat(funding);
    if (isNaN(fundingNumber) || fundingNumber <= 0) {
      addLog("Nilai initial funding tidak valid. Harap masukkan angka positif.", "error");
      initialFundingInput.clearValue();
      screen.focusPush(initialFundingInput);
      safeRender();
      isDeployingContract = false;
      return;
    }

    deployContractForm.hide();
    contractNameInput.clearValue();
    initialFundingInput.clearValue();
    wasLabsSubMenu.show();
    setTimeout(() => {
      if (wasLabsSubMenu.visible) {
        screen.focusPush(wasLabsSubMenu);
        wasLabsSubMenu.style.border.fg = "yellow";
        logBox.style.border.fg = "magenta";
        safeRender();
      }
    }, 100);

    handleDeployContract(name, fundingNumber);
  } catch (error) {
    addLog(`Kesalahan validasi input deploy contract: ${error.message}`, "error");
    isDeployingContract = false;
  }
});

tokenSupplyInput.on("input", () => {
  let value = tokenSupplyInput.getValue().replace(/,/g, '');
  if (!isNaN(value) && value !== '') {
    const numValue = parseFloat(value);
    if (!isNaN(numValue)) {
      tokenSupplyInput.setValue(numValue.toLocaleString('en-US'));
      safeRender();
    }
  }
});

configInput.key(["enter"], () => {
  if (["xosSwapRange", "usdcSwapRange", "bnbSwapRange"].includes(configForm.configType)) {
    screen.focusPush(configInputMax);
  } else {
    configForm.submit();
  }
});

configInputMax.key(["enter"], () => {
  configForm.submit();
});

configSubmitButton.on("press", () => {
  configForm.submit();
});

configSubmitButton.on("click", () => {
  screen.focusPush(configSubmitButton);
  configForm.submit();
});

tokenNameInput.key(["enter"], () => {
  screen.focusPush(tokenSymbolInput);
});

tokenSymbolInput.key(["enter"], () => {
  screen.focusPush(tokenSupplyInput);
});

tokenSupplyInput.key(["enter"], () => {
  createTokenForm.submit();
});

createTokenButton.on("press", () => {
  createTokenForm.submit();
});

createTokenButton.on("click", () => {
  screen.focusPush(createTokenButton);
  createTokenForm.submit();
});

cancelTokenButton.on("press", () => {
  createTokenForm.hide();
  tokenNameInput.clearValue();
  tokenSymbolInput.clearValue();
  tokenSupplyInput.clearValue();
  wasLabsSubMenu.show();
  setTimeout(() => {
    if (wasLabsSubMenu.visible) {
      screen.focusPush(wasLabsSubMenu);
      wasLabsSubMenu.style.border.fg = "yellow";
      logBox.style.border.fg = "magenta";
      safeRender();
    }
  }, 100);
});

cancelTokenButton.on("click", () => {
  screen.focusPush(cancelTokenButton);
  cancelTokenButton.emit("press");
});

contractNameInput.key(["enter"], () => {
  screen.focusPush(initialFundingInput);
});

initialFundingInput.key(["enter"], () => {
  deployContractForm.submit();
});

deployContractButton.on("press", () => {
  deployContractForm.submit();
});

deployContractButton.on("click", () => {
  screen.focusPush(deployContractButton);
  deployContractForm.submit();
});

cancelDeployButton.on("press", () => {
  deployContractForm.hide();
  contractNameInput.clearValue();
  initialFundingInput.clearValue();
  wasLabsSubMenu.show();
  setTimeout(() => {
    if (wasLabsSubMenu.visible) {
      screen.focusPush(wasLabsSubMenu);
      wasLabsSubMenu.style.border.fg = "yellow";
      logBox.style.border.fg = "magenta";
      safeRender();
    }
  }, 100);
});

cancelDeployButton.on("click", () => {
  screen.focusPush(cancelDeployButton);
  cancelDeployButton.emit("press");
});

configForm.key(["escape"], () => {
  configForm.hide();
  dailyActivitySubMenu.show();
  setTimeout(() => {
    if (dailyActivitySubMenu.visible) {
      screen.focusPush(dailyActivitySubMenu);
      dailyActivitySubMenu.style.border.fg = "yellow";
      logBox.style.border.fg = "magenta";
      safeRender();
    }
  }, 100);
});

dailyActivitySubMenu.key(["escape"], () => {
  dailyActivitySubMenu.hide();
  menuBox.show();
  setTimeout(() => {
    if (menuBox.visible) {
      screen.focusPush(menuBox);
      menuBox.style.border.fg = "cyan";
      dailyActivitySubMenu.style.border.fg = "blue";
      logBox.style.border.fg = "magenta";
      safeRender();
    }
  }, 100);
});

wasLabsSubMenu.key(["escape"], () => {
  wasLabsSubMenu.hide();
  menuBox.show();
  setTimeout(() => {
    if (menuBox.visible) {
      screen.focusPush(menuBox);
      menuBox.style.border.fg = "cyan";
      wasLabsSubMenu.style.border.fg = "green";
      logBox.style.border.fg = "magenta";
      safeRender();
    }
  }, 100);
});

createTokenForm.key(["escape"], () => {
  createTokenForm.hide();
  tokenNameInput.clearValue();
  tokenSymbolInput.clearValue();
  tokenSupplyInput.clearValue();
  wasLabsSubMenu.show();
  setTimeout(() => {
    if (wasLabsSubMenu.visible) {
      screen.focusPush(wasLabsSubMenu);
      wasLabsSubMenu.style.border.fg = "yellow";
      logBox.style.border.fg = "magenta";
      safeRender();
    }
  }, 100);
});

deployContractForm.key(["escape"], () => {
  deployContractForm.hide();
  contractNameInput.clearValue();
  initialFundingInput.clearValue();
  wasLabsSubMenu.show();
  setTimeout(() => {
    if (wasLabsSubMenu.visible) {
      screen.focusPush(wasLabsSubMenu);
      wasLabsSubMenu.style.border.fg = "yellow";
      logBox.style.border.fg = "magenta";
      safeRender();
    }
  }, 100);
});

screen.key(["escape", "q", "C-c"], () => {
  addLog("Exiting application", "info");
  clearInterval(statusInterval);
  process.exit(0);
});

async function initialize() {
  try {
    loadConfig();
    loadAccounts();
    loadProxies();
    updateStatus();
    await updateWallets();
    updateLogs();
    safeRender();
    menuBox.focus();
  } catch (error) {
    addLog(`Initialization error: ${error.message}`, "error");
  }
}

setTimeout(() => {
  adjustLayout();
  screen.on("resize", adjustLayout);
}, 100);

initialize();
