import {
  createPublicClient,
  createWalletClient,
  decodeAbiParameters,
  encodeAbiParameters,
  http,
  erc20Abi,
  formatEther,
  zeroAddress,
  isAddress,
  isAddressEqual,
  Abi,
  Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ReportV3, ReportV4, StreamReport } from '../types';
import { feeManagerAbi, verifierProxyAbi } from '../config/abi';
import { logger } from './logger';
import { getAllChains } from '../config/chains';
import { verifiers } from '../config/verifiers';
import { getChainId, getContractAddress, getGasCap } from 'server/store';

const account = privateKeyToAccount(process.env.PRIVATE_KEY as Hex);
export const accountAddress = account.address;

export async function executeContract({
  report,
  abi,
  functionName,
  functionArgs,
}: {
  report: ReportV3;
  abi: Abi;
  functionName: string;
  functionArgs: string[];
}) {
  if (!abi || abi.length === 0) {
    logger.warn('⚠️ No abi provided');
    return;
  }
  if (!functionName || functionName.length === 0) {
    logger.warn('⚠️ No functionName provided');
    return;
  }
  if (!functionArgs || functionArgs.length === 0) {
    logger.warn('⚠️ No args provided');
    return;
  }

  logger.info('📝 Prepared verification transaction', report);

  const args = functionArgs.map((arg) => report[arg as keyof ReportV3]);

  const address = await getContractAddress();
  if (!address || !isAddress(address)) return;
  const clients = await getClients();
  if (!clients || !clients.publicClient || !clients.walletClient) {
    logger.warn('⚠️ Invalid clients', { clients });
    return;
  }
  const { publicClient, walletClient } = clients;
  const gas = await publicClient.estimateContractGas({
    account,
    address,
    abi,
    functionName,
    args,
  });
  logger.info(
    `⛽️ Estimated gas: ${formatEther(gas)} ${
      publicClient.chain?.nativeCurrency.symbol
    }`,
    { gas }
  );
  const gasCap = await getGasCap();
  if (gasCap && gas > BigInt(gasCap)) {
    logger.info(
      `🛑 Gas is above the limit of ${formatEther(BigInt(gasCap))} | Aborting`,
      { gas, gasCap }
    );
    return;
  }
  const { request } = await publicClient.simulateContract({
    account,
    address,
    abi,
    functionName,
    args,
  });
  logger.info('ℹ️ Transaction simulated', request);

  const hash = await walletClient.writeContract(request);
  logger.info(`⌛️ Sending transaction ${hash} `, hash);
  return await publicClient.waitForTransactionReceipt({ hash });
}

export async function getContractAddresses() {
  try {
    const clients = await getClients();
    if (!clients || !clients.publicClient) {
      logger.warn('⚠️ Invalid clients', { clients });
      return {
        verifierProxyAddress: zeroAddress,
        feeManagerAddress: zeroAddress,
        rewardManagerAddress: zeroAddress,
        feeTokenAddress: zeroAddress,
      };
    }
    const { publicClient } = clients;
    const chainId = await getChainId();
    if (!chainId) {
      logger.warn('⚠️ No chainId provided');
      return;
    }
    const verifierProxyAddress = verifiers[Number(chainId)];

    const feeManagerAddress = await publicClient.readContract({
      address: verifierProxyAddress,
      abi: verifierProxyAbi,
      functionName: 's_feeManager',
    });
    const rewardManagerAddress = await publicClient.readContract({
      address: feeManagerAddress,
      abi: feeManagerAbi,
      functionName: 'i_rewardManager',
    });
    const feeTokenAddress = await publicClient.readContract({
      address: feeManagerAddress,
      abi: feeManagerAbi,
      functionName: 'i_linkAddress',
    });

    return {
      verifierProxyAddress,
      feeManagerAddress,
      rewardManagerAddress,
      feeTokenAddress,
    };
  } catch (error) {
    logger.error('ERROR', { error });
    return {
      verifierProxyAddress: zeroAddress,
      feeManagerAddress: zeroAddress,
      rewardManagerAddress: zeroAddress,
      feeTokenAddress: zeroAddress,
    };
  }
}

export async function verifyReport(report: StreamReport) {
  try {
    const clients = await getClients();
    if (!clients || !clients.publicClient || !clients.walletClient) {
      logger.warn('⚠️ Invalid clients', { clients });
      return;
    }
    const { publicClient, walletClient } = clients;

    const [, reportData] = decodeAbiParameters(
      [
        { type: 'bytes32[3]', name: '' },
        { type: 'bytes', name: 'reportData' },
      ],
      report.rawReport
    );

    const reportVersion = reportData.charAt(5);
    if (reportVersion !== '3' && reportVersion !== '4') {
      logger.warn('⚠️ Invalid report version', { report });
      return;
    }

    const contractAddresses = await getContractAddresses();

    if (
      !contractAddresses ||
      Object.values(contractAddresses)
        .map((address) => isAddressValid(address))
        .includes(false)
    ) {
      logger.warn('⚠️ Invalid contract addresses', { contractAddresses });
      return;
    }

    const {
      feeManagerAddress,
      rewardManagerAddress,
      feeTokenAddress,
      verifierProxyAddress,
    } = contractAddresses;

    const [fee] = await publicClient.readContract({
      address: feeManagerAddress,
      abi: feeManagerAbi,
      functionName: 'getFeeAndReward',
      args: [account.address, reportData, feeTokenAddress],
    });
    logger.info(`⛽️ Estimated fee: ${formatEther(fee.amount)} LINK`, { fee });

    const feeTokenAddressEncoded = encodeAbiParameters(
      [{ type: 'address', name: 'parameterPayload' }],
      [feeTokenAddress]
    );

    const approveLinkGas = await publicClient.estimateContractGas({
      account,
      address: feeTokenAddress,
      abi: erc20Abi,
      functionName: 'approve',
      args: [rewardManagerAddress, fee.amount],
    });

    logger.info(
      `⛽️ Estimated gas for LINK approval: ${formatEther(approveLinkGas)} ${
        publicClient.chain?.nativeCurrency.symbol
      }`,
      { approveLinkGas }
    );
    const gasCap = await getGasCap();
    if (gasCap && approveLinkGas > BigInt(gasCap)) {
      logger.info(
        `🛑 LINK approval gas is above the limit of ${formatEther(
          BigInt(gasCap)
        )} | Aborting`,
        { approveLinkGas, gasCap }
      );
      return;
    }

    const { request: approveLinkRequest } = await publicClient.simulateContract(
      {
        account,
        address: feeTokenAddress,
        abi: erc20Abi,
        functionName: 'approve',
        args: [rewardManagerAddress, fee.amount],
      }
    );
    const approveLinkHash = await walletClient.writeContract(
      approveLinkRequest
    );
    await publicClient.waitForTransactionReceipt({ hash: approveLinkHash });

    const verifyReportGas = await publicClient.estimateContractGas({
      account,
      address: verifierProxyAddress,
      abi: verifierProxyAbi,
      functionName: 'verify',
      args: [report.rawReport, feeTokenAddressEncoded],
    });
    logger.info(
      `⛽️ Estimated gas for verification: ${formatEther(verifyReportGas)} ${
        publicClient.chain?.nativeCurrency.symbol
      }`,
      { verifyReportGas }
    );
    if (gasCap && verifyReportGas > BigInt(gasCap)) {
      logger.info(
        `🛑 Verification gas is above the limit of ${formatEther(
          BigInt(gasCap)
        )} | Aborting`,
        { verifyReportGas, gasCap }
      );
      return;
    }
    const { request: verifyReportRequest, result: verifiedReportData } =
      await publicClient.simulateContract({
        account,
        address: verifierProxyAddress,
        abi: verifierProxyAbi,
        functionName: 'verify',
        args: [report.rawReport, feeTokenAddressEncoded],
      });
    const verifyReportHash = await walletClient.writeContract(
      verifyReportRequest
    );
    await publicClient.waitForTransactionReceipt({ hash: verifyReportHash });

    if (reportVersion === '3') {
      const [
        feedId,
        validFromTimestamp,
        observationsTimestamp,
        nativeFee,
        linkFee,
        expiresAt,
        price,
        bid,
        ask,
      ] = decodeAbiParameters(
        [
          { type: 'bytes32', name: 'feedId' },
          { type: 'uint32', name: 'validFromTimestamp' },
          { type: 'uint32', name: 'observationsTimestamp' },
          { type: 'uint192', name: 'nativeFee' },
          { type: 'uint192', name: 'linkFee' },
          { type: 'uint32', name: 'expiresAt' },
          { type: 'int192', name: 'price' },
          { type: 'int192', name: 'bid' },
          { type: 'int192', name: 'ask' },
        ],
        verifiedReportData
      );
      const verifiedReport: ReportV3 = {
        feedId,
        validFromTimestamp,
        observationsTimestamp,
        nativeFee,
        linkFee,
        expiresAt,
        price,
        bid,
        ask,
      };
      return verifiedReport;
    }
    if (reportVersion === '4') {
      const [
        feedId,
        validFromTimestamp,
        observationsTimestamp,
        nativeFee,
        linkFee,
        expiresAt,
        price,
        marketStatus,
      ] = decodeAbiParameters(
        [
          { type: 'bytes32', name: 'feedId' },
          { type: 'uint32', name: 'validFromTimestamp' },
          { type: 'uint32', name: 'observationsTimestamp' },
          { type: 'uint192', name: 'nativeFee' },
          { type: 'uint192', name: 'linkFee' },
          { type: 'uint32', name: 'expiresAt' },
          { type: 'int192', name: 'price' },
          { type: 'uint32', name: 'marketStatus' },
        ],
        verifiedReportData
      );
      const verifiedReport: ReportV4 = {
        feedId,
        validFromTimestamp,
        observationsTimestamp,
        nativeFee,
        linkFee,
        expiresAt,
        price,
        marketStatus,
      };
      return verifiedReport;
    }
  } catch (error) {
    logger.error('ERROR', { error });
  }
}

const isAddressValid = (address: string) =>
  !isAddress(address) || isAddressEqual(address, zeroAddress) ? false : true;

async function getClients() {
  const chainId = await getChainId();
  if (!chainId) {
    logger.warn('⚠️ No chainId provided');
    return;
  }
  const chains = await getAllChains();
  const chain = chains.find((chain) => chain.id === Number(chainId));
  if (!chain) {
    logger.warn('⚠️ Invalid chain', { chainId });
  }
  const publicClient = createPublicClient({
    chain,
    transport: http(),
  });
  const walletClient = createWalletClient({
    chain,
    transport: http(),
  });
  return { publicClient, walletClient };
}
