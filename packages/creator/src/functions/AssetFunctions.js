import { getAddress } from './UIStateFunctions';
import { getAddressFromMnemonic, getBlockchain, runSidechainTransaction, runMainnetTransaction, getTransactionSignature } from '../webaverse/blockchain.js';
import { previewExt, previewHost, storageHost } from '../webaverse/constants.js';
import { getExt } from '../webaverse/util.js';
import bip39 from '../libs/bip39.js';
import hdkeySpec from '../libs/hdkey.js';
const hdkey = hdkeySpec.default;

export const getStuckAsset = async (tokenName, tokenId, globalState) => {
  if (!globalState.loginToken) return null;
  const { contracts, getNetworkName, getMainnetAddress } = await getBlockchain();
  const wallet = hdkey.fromMasterSeed(bip39.mnemonicToSeedSync(globalState.loginToken.mnemonic)).derivePath(`m/44'/60'/0'/0/0`).getWallet();
  const address = wallet.getAddressString();

  const mainnetAddress = await getMainnetAddress();
  const networkName = getNetworkName();

  let chainName, otherChainName;
  if (networkName === "main") {
    chainName = 'front';
    otherChainName = 'back';
  } else {
    otherChainName = 'front';
    chainName = 'back';
  }

  const contract = contracts[chainName];
  const proxyContract = contract[tokenName + 'Proxy'];
  const otherContract = contracts[otherChainName];
  const otherProxyContract = otherContract[tokenName + 'Proxy'];

  const [
    depositedEntries,
    withdrewEntries,
    otherDepositedEntries,
    otherWithdrewEntries,
  ] = await Promise.all([
    proxyContract.getPastEvents('Deposited', {
      fromBlock: 0,
      toBlock: 'latest',
    }),
    proxyContract.getPastEvents('Withdrew', {
      fromBlock: 0,
      toBlock: 'latest',
    }),
    otherProxyContract.getPastEvents('Deposited', {
      fromBlock: 0,
      toBlock: 'latest',
    }),
    otherProxyContract.getPastEvents('Withdrew', {
      fromBlock: 0,
      toBlock: 'latest',
    }),
  ]);

  let depositedFiltered;
  if (tokenId) {
    depositedFiltered = depositedEntries.filter(entry => entry.returnValues[0].toLowerCase() === address && entry.returnValues[1] === tokenId.toString());
  } else {
    depositedFiltered = depositedEntries.filter(entry => entry.returnValues[0].toLowerCase() === address);
  }

  const deposits = depositedFiltered[depositedFiltered.length-1];
  return deposits;
}

export const resubmitAsset = async (tokenName, tokenIdNum, globalState, successCallback, errorCallback) => {
  const { getNetworkName } = await getBlockchain();
  const stuckAsset = await getStuckAsset(tokenName, tokenIdNum, globalState);
  if (!stuckAsset) return null;

  let {transactionHash, blockNumber, returnValues, returnValues: {to, tokenId}} = stuckAsset;

  if (!to) {
    to = returnValues[0];
  }
  if (!tokenId) {
    tokenId = returnValues[1];
  }
  to = to.toLowerCase();
  tokenId = parseInt(tokenId, 10);

  if (to === globalState.address) {
    const networkName = getNetworkName();
    const fullChainName = networkName + 'sidechain';

    const res = await fetch(`https://sign.exokit.org/${fullChainName}/${tokenName}/${transactionHash}`);
    const signatureJson = await res.json();
    const {timestamp, r, s, v} = signatureJson;

    try {
      await runMainnetTransaction(tokenName + 'Proxy', 'withdraw', to, tokenId, timestamp, r, s, v);
      return;
    } catch (err) {
      console.log("mainnet transaction error", err);
      errorCallback(err);
      return err;
    }
  }
}

export const deleteAsset = async (id, mnemonic, successCallback, errorCallback) => {
  const wallet = hdkey.fromMasterSeed(bip39.mnemonicToSeedSync(mnemonic)).derivePath(`m/44'/60'/0'/0/0`).getWallet();
  const address = wallet.getAddressString();

  try {
    const network = 'sidechain';
    const burnAddress = "0x000000000000000000000000000000000000dEaD";

    const result = await runSidechainTransaction(mnemonic)('NFT', 'transferFrom', address, burnAddress, id);

    if(result) console.log("Result of delete transaction:", result);

    if (successCallback)
      successCallback(result);
  } catch (error) {
    if (errorCallback)
      errorCallback(error);
  }
}

export const buyAsset = async (id, networkType, mnemonic, successCallback, errorCallback) => {
  const { web3, contracts } = await getBlockchain();
  const wallet = hdkey.fromMasterSeed(bip39.mnemonicToSeedSync(mnemonic)).derivePath(`m/44'/60'/0'/0/0`).getWallet();
  const address = wallet.getAddressString();

  const fullAmount = {
    t: 'uint256',
    v: new web3['back'].utils.BN(1e9)
      .mul(new web3['back'].utils.BN(1e9))
      .mul(new web3['back'].utils.BN(1e9)),
  };
  const fullAmountD2 = {
    t: 'uint256',
    v: fullAmount.v.div(new web3['back'].utils.BN(2)),
  };

  try {
    {
      let allowance = await contracts['back']['FT'].methods.allowance(address, contracts['back']['Trade']._address).call();
      allowance = new web3['back'].utils.BN(allowance, 10);
      if (allowance.lt(fullAmountD2.v)) {
        await runSidechainTransaction(mnemonic)('FT', 'approve', contracts['back']['Trade']._address, fullAmount.v);
      }
    }

    const result = await runSidechainTransaction(mnemonic)('Trade', 'buy', id);

    if (successCallback)
      successCallback(result);
  } catch (error) {
    if (errorCallback)
      errorCallback(error);
  }
};

export const sellAsset = async (id, price, networkType, mnemonic, successCallback, errorCallback) => {
  const { web3, contracts } = await getBlockchain();
  try {
    const network = networkType.toLowerCase() === 'mainnet' ? 'mainnet' : 'sidechain';

    await runSidechainTransaction(mnemonic)('NFT', 'setApprovalForAll', contracts[network]['Trade']._address, true);
    const result = await runSidechainTransaction(mnemonic)('Trade', 'addStore', id, price);

    if (successCallback)
      successCallback(result);
  } catch (error) {
    if (errorCallback)
      errorCallback(error);
  }
};

export const cancelSale = async (id, networkType, successCallback, errorCallback) => {
  const { web3, contracts } = await getBlockchain();
  try {
    const network = networkType.toLowerCase() === 'mainnet' ? 'mainnet' : 'sidechain';
    await runSidechainTransaction(mnemonic)('NFT', 'setApprovalForAll', contracts[network]['Trade']._address, true);

    await runSidechainTransaction(mnemonic)('Trade', 'removeStore', id);

    console.log("No buy asset logic");
    if (successCallback)
      successCallback();
  } catch (error) {
    if (errorCallback)
      errorCallback(error);
  }
};

export const setAssetName = async (name, hash, state, successCallback, errorCallback) => {
  if (!state.loginToken)
    throw new Error('not logged in');
  try {
    await Promise.all([
      runSidechainTransaction(state.loginToken.mnemonic)('NFT', 'setMetadata', hash, 'name', name),
    ]);
    if (successCallback)
      successCallback();

    return;
  } catch (error) {
    if (errorCallback) {
      errorCallback(error);
      return;
    }
  }
};


export const setName = async (name, state, successCallback, errorCallback) => {
  if (!state.loginToken)
    throw new Error('not logged in');
  try {
    const address = state.address;
    await Promise.all([
      runSidechainTransaction(state.loginToken.mnemonic)('Account', 'setMetadata', address, 'name', name),
    ]);
    if (successCallback)
      successCallback();

    const newState = {...state, name };
    return newState;
  } catch (error) {
    if (errorCallback) {
      errorCallback(error);
      return state;
    }
  }
};


export const setAvatar = async (id, state, successCallback, errorCallback) => {
  const { getNetworkName } = await getBlockchain();
  const networkName = getNetworkName();

  if (!state.loginToken)
    throw new Error('not logged in');
  try {
    const res = await fetch(`${networkName !== "main" ? `https://rinkebysidechain-tokens.webaverse.com/${id}` : `https://mainnetsidechain-tokens.webaverse.com/${id}`}`);
    const token = await res.json();
    const { name, ext, hash } = token.properties;
    const url = `${storageHost}/${hash.slice(2)}`;
    const preview = `${previewHost}/${hash}${ext ? ('.' + ext) : ''}/preview.${previewExt}`;
    const address = state.address;
    await Promise.all([
      runSidechainTransaction(state.loginToken.mnemonic)('Account', 'setMetadata', address, 'avatarId', id + ''),
      runSidechainTransaction(state.loginToken.mnemonic)('Account', 'setMetadata', address, 'avatarName', name),
      runSidechainTransaction(state.loginToken.mnemonic)('Account', 'setMetadata', address, 'avatarExt', ext),
      runSidechainTransaction(state.loginToken.mnemonic)('Account', 'setMetadata', address, 'avatarPreview', preview),
    ]);
    if (successCallback)
      successCallback();

    const newState = {...state, avatarPreview: preview };
    return newState;
  } catch (error) {
    if (errorCallback) {
      errorCallback(error);
      return state;
    }
  }
};

export const removeNftCollaborator = async (hash, address, successCallback, errorCallback, state) => {
  const mnemonic = state.loginToken.mnemonic;

  if (address) {
    let status, transactionHash;
    try {
      const result = await runSidechainTransaction(mnemonic)('NFT', 'removeCollaborator', hash, address);
      status = result.status;
    } catch(err) {
      status = false;
      transactionHash = err.message;
    }

    if (status) {
      successCallback();
    } else {
      errorCallback(transactionHash);
    }
  } else {
    errorCallback("No address given.");
  }
}

export const addNftCollaborator = async (hash, address, successCallback, errorCallback, state) => {
  const mnemonic = state.loginToken.mnemonic;

  if (address) {
    let status, transactionHash;
    try {
      const result = await runSidechainTransaction(mnemonic)('NFT', 'addCollaborator', hash, address);
      status = result.status;
    } catch(err) {
      status = false;
      transactionHash = err.message;
    }

    if (status) {
      successCallback();
    } else {
      errorCallback(transactionHash);
    }
  } else {
    errorCallback("No address given.");
  }
}

export const getLandHash = async (id) => {
  const { web3, contracts } = await getBlockchain();
  const hash = contracts.back.LAND.methods.getSingleMetadata(id, 'hash').call();

  return hash;
}

export const removeLandCollaborator = async (tokenId, address, successCallback, errorCallback, state) => {
  const mnemonic = state.loginToken.mnemonic;

  if (address) {
    let status, transactionHash;
    try {
      const result = await runSidechainTransaction(mnemonic)('LAND', 'removeSingleCollaborator', tokenId, address);
      status = result.status;
    } catch(err) {
      status = false;
      transactionHash = err.message;
    }

    if (status) {
      successCallback();
    } else {
      errorCallback(transactionHash);
    }
  } else {
    errorCallback("No address given.");
  }
}

export const addLandCollaborator = async (tokenId, address, successCallback, errorCallback, state) => {
  const mnemonic = state.loginToken.mnemonic;

  if (address) {
    let status, transactionHash;
    try {
      const result = await runSidechainTransaction(mnemonic)('LAND', 'addSingleCollaborator', tokenId, address);
      status = result.status;
    } catch(err) {
      status = false;
      transactionHash = err.message;
    }

    if (status) {
      successCallback();
    } else {
      errorCallback(transactionHash);
    }
  } else {
    errorCallback("No address given.");
  }
}


export const deployLand = async (tokenId, contentId, successCallback, errorCallback, state) => {
  const mnemonic = state.loginToken.mnemonic;

  if (!isNaN(contentId)) {
    let status, transactionHash;
    try {
        const result = await runSidechainTransaction(mnemonic)('LAND', 'setSingleMetadata', tokenId, 'hash', contentId);
        status = result.status;
    } catch(err) {
      status = false;
      transactionHash = err.message;
    }

    if (status) {
      successCallback();
    } else {
      errorCallback(transactionHash);
    }
  } else {
    errorCallback("Invalid NFT ID");
  }
}

export const mintNft = async (hash, name, ext, description, quantity, successCallback, errorCallback, state) => {
  const { web3, contracts } = await getBlockchain();
  const  mnemonic = state.loginToken.mnemonic;
  const address = state.address;

  let status, transactionHash, tokenIds;

  try {

    const fullAmount = {
      t: 'uint256',
      v: new web3['back'].utils.BN(1e9)
        .mul(new web3['back'].utils.BN(1e9))
        .mul(new web3['back'].utils.BN(1e9)),
    };
    const fullAmountD2 = {
      t: 'uint256',
      v: fullAmount.v.div(new web3['back'].utils.BN(2)),
    };

    let allowance = await contracts.back.FT.methods.allowance(address, contracts['back']['NFT']._address).call();
    allowance = new web3['back'].utils.BN(allowance, 10);
    if (allowance.lt(fullAmountD2.v)) {
      const result = await runSidechainTransaction(mnemonic)('FT', 'approve', contracts['back']['NFT']._address, fullAmount.v);
      status = result.status;
    } else {
      status = true;
//      transactionHash = '0x0';
//      tokenIds = [];
    }

    if (status) {
      const result = await runSidechainTransaction(mnemonic)('NFT', 'mint', address, hash, name, ext, description, quantity);

      status = result.status;
      transactionHash = result.transactionHash;
      const tokenId = new web3['back'].utils.BN(result.logs[0].topics[3].slice(2), 16).toNumber();
      tokenIds = [tokenId, tokenId + quantity - 1];
      successCallback(tokenId);
    }
  } catch (err) {
    console.warn(err);
    status = false;
    transactionHash = '0x0';
    tokenIds = [];
    errorCallback(err);
  }
};

export const setHomespace = async (id, state, successCallback, errorCallback) => {
  if (!state.loginToken)
    throw new Error('not logged in');
  const { getNetworkName } = await getBlockchain();
  const networkName = getNetworkName();

  try {

    const res = await fetch(`${networkName !== "main" ? `https://rinkebysidechain-tokens.webaverse.com/${id}` : `https://mainnetsidechain-tokens.webaverse.com/${id}`}`);
    const token = await res.json();
    const { name, ext, hash } = token.properties;
    const url = `${storageHost}/${hash.slice(2)}`;
    const preview = `${previewHost}/${hash}${ext ? ('.' + ext) : ''}/preview.${previewExt}`;
    const address = state.address;
    await Promise.all([
      runSidechainTransaction(state.loginToken.mnemonic)('Account', 'setMetadata', address, 'homeSpaceId', id + ''),
      runSidechainTransaction(state.loginToken.mnemonic)('Account', 'setMetadata', address, 'homeSpaceName', name),
      runSidechainTransaction(state.loginToken.mnemonic)('Account', 'setMetadata', address, 'homeSpaceExt', ext),
      runSidechainTransaction(state.loginToken.mnemonic)('Account', 'setMetadata', address, 'homeSpacePreview', preview),
    ]);
    if (successCallback !== undefined)
      successCallback();

    const newState = {...state, homeSpacePreview: preview };
    return newState;
  } catch (err) {
    console.log("ERROR: ", err);
    if (errorCallback !== undefined)
      errorCallback();

    return state;
  }
};

export const depositFlux = async (amount, mainnetAddress, state, successCallback, errorCallback) => {
  const { web3, contracts } = await getBlockchain();
  const wallet = hdkey.fromMasterSeed(bip39.mnemonicToSeedSync(state.loginToken.mnemonic)).derivePath(`m/44'/60'/0'/0/0`).getWallet();
  const address = wallet.getAddressString();
  // Withdraw from mainnet
  amount = parseInt(amount, 10);

  await runSidechainTransaction(state.loginToken.mnemonic)('FT', 'approve', contracts['back'].FTProxy._address, amount);

  const receipt = await runSidechainTransaction(state.loginToken.mnemonic)('FTProxy', 'deposit', mainnetAddress, amount);

  const signature = await getTransactionSignature('back', 'FT', receipt.transactionHash);
  const timestamp = {
    t: 'uint256',
    v: signature.timestamp,
  };

  const { r, s, v } = signature;

  try {
    await contracts.front.FTProxy.methods.withdraw(mainnetAddress, amount, timestamp.v, r, s, v).send({
      from: mainnetAddress,
    });
    successCallback();
  } catch (err) {
    errorCallback(err);
  }

  return;
}

export const withdrawFlux = async (amount, mainnetAddress, address, state, successCallback, errorCallback) => {
  const { web3, contracts } = await getBlockchain();
  // Withdraw from mainnet
  amount = parseInt(amount, 10);
  amount = {
    t: 'uint256',
    v: new web3['front'].utils.BN(amount),
  };

  await contracts.front.FT.methods.approve(contracts.front.FTProxy._address, amount.v).send({
    from: mainnetAddress,
  });

  const receipt = await contracts.front.FTProxy.methods.deposit(address, amount.v).send({
    from: mainnetAddress,
  });

  const signature = await getTransactionSignature('front', 'FT', receipt.transactionHash);
  const timestamp = {
    t: 'uint256',
    v: signature.timestamp,
  };

  const { r, s, v } = signature;

  try {
    await runSidechainTransaction(state.loginToken.mnemonic)('FTProxy', 'withdraw', address, amount.v, timestamp.v, r, s, v);
    successCallback();
  } catch (err) {
    errorCallback(err);
  }

  return;
}


export const withdrawLand = async (tokenId, mainnetAddress, address, state, successCallback, errorCallback) => {
  const { web3, contracts } = await getBlockchain();
  // Withdraw from mainnet
  const id = parseInt(tokenId, 10);
  tokenId = {
    t: 'uint256',
    v: new web3['front'].utils.BN(id),
  };

  await contracts.front.LAND.methods.setApprovalForAll(contracts.front.LANDProxy._address, true).send({
    from: mainnetAddress,
  });

  const receipt = await contracts.front.LANDProxy.methods.deposit(address, tokenId.v).send({
    from: mainnetAddress,
  });

  const signature = await getTransactionSignature('front', 'LAND', receipt.transactionHash);
  const timestamp = {
    t: 'uint256',
    v: signature.timestamp,
  };

  const { r, s, v } = signature;

  await runSidechainTransaction(state.loginToken.mnemonic)('LANDProxy', 'withdraw', address, tokenId.v, timestamp.v, r, s, v);

  successCallback();

  return;
}

export const depositLand = async (tokenId, mainnetAddress, state) => {
  const { web3, contracts } = await getBlockchain();
  const wallet = hdkey.fromMasterSeed(bip39.mnemonicToSeedSync(state.loginToken.mnemonic)).derivePath(`m/44'/60'/0'/0/0`).getWallet();
  const address = wallet.getAddressString();

// Deposit to mainnet
  const id = parseInt(tokenId, 10);
  if (!isNaN(id)) {
    const tokenId = {
      t: 'uint256',
      v: new web3['back'].utils.BN(id),
    };

    await runSidechainTransaction(state.loginToken.mnemonic)('LAND', 'setApprovalForAll', contracts['back'].LANDProxy._address, true);

    const receipt = await runSidechainTransaction(state.loginToken.mnemonic)('LANDProxy', 'deposit', mainnetAddress, tokenId.v);

    const signature = await getTransactionSignature('back', 'LAND', receipt.transactionHash);
    const timestamp = {
      t: 'uint256',
      v: signature.timestamp,
    };

    const { r, s, v } = signature;

    await contracts.front.LANDProxy.methods.withdraw(mainnetAddress, tokenId.v, timestamp.v, r, s, v).send({
      from: mainnetAddress,
    });

    return;
  }
}

export const withdrawAsset = async (tokenId, mainnetAddress, address, state, successCallback, errorCallback) => {
  const { web3, contracts } = await getBlockchain();
  // Withdraw from mainnet
  const id = parseInt(tokenId, 10);
  tokenId = {
    t: 'uint256',
    v: new web3['front'].utils.BN(id),
  };

  await contracts.front.NFT.methods.setApprovalForAll(contracts.front.NFTProxy._address, true).send({
    from: mainnetAddress,
  });

  const receipt = await contracts.front.NFTProxy.methods.deposit(address, tokenId.v).send({
    from: mainnetAddress,
  });

  const signature = await getTransactionSignature('front', 'NFT', receipt.transactionHash);
  const timestamp = {
    t: 'uint256',
    v: signature.timestamp,
  };

  const { r, s, v } = signature;

  await runSidechainTransaction(state.loginToken.mnemonic)('NFTProxy', 'withdraw', address, tokenId.v, timestamp.v, r, s, v);

  successCallback();

  return;
}

export const depositAsset = async (tokenId, networkType, mainnetAddress, address, state) => {
  const { web3, contracts } = await getBlockchain();
  // Deposit to mainnet
  if (networkType === 'webaverse') {
    const id = parseInt(tokenId, 10);
    if (!isNaN(id)) {
      const tokenId = {
        t: 'uint256',
        v: new web3['back'].utils.BN(id),
      };

      await runSidechainTransaction(state.loginToken.mnemonic)('NFT', 'setApprovalForAll', contracts['back'].NFTProxy._address, true);

      const receipt = await runSidechainTransaction(state.loginToken.mnemonic)('NFTProxy', 'deposit', mainnetAddress, tokenId.v);

      const signature = await getTransactionSignature('back', 'NFT', receipt.transactionHash);
      const timestamp = {
        t: 'uint256',
        v: signature.timestamp,
      };

      const { r, s, v } = signature;

      await contracts.front.NFTProxy.methods.withdraw(mainnetAddress, tokenId.v, timestamp.v, r, s, v).send({
        from: mainnetAddress,
      });

      return;
    } else {
      console.log('failed to parse', JSON.stringify(ethNftIdInput.value));
    }
  }  else {
    const id = parseInt(tokenId, 10);
    const tokenId = {
      t: 'uint256',
      v: new web3['front'].utils.BN(id),
    };

    const hashSpec = await contracts.front.NFT.methods.getHash(tokenId.v).call();
    const hash = {
      t: 'uint256',
      v: new web3['front'].utils.BN(hashSpec),
    };
    const filenameSpec = await contracts.front.NFT.methods.getMetadata(hashSpec, 'filename').call();
    const filename = {
      t: 'string',
      v: filenameSpec,
    };

    const descriptionSpec = await contracts.front.NFT.methods.getMetadata(hashSpec, 'description').call();
    const description = {
      t: 'string',
      v: descriptionSpec,
    };


    await _checkMainNftApproved();

    const receipt = await contracts.front.NFTProxy.methods.deposit(myAddress, tokenId.v).send({
      from: mainnetAddress,
    });

    const signature = await getTransactionSignature('front', 'NFT', receipt.transactionHash);

    const { timestamp, r, s, v } = signature;

    await runSidechainTransaction('NFTProxy', 'withdraw', myAddress, tokenId.v, hash.v, filename.v, description.v, timestamp, r, s, v);

    return;
  }
}

export const getLoadout = async (address) => {
  const { web3, contracts } = await getBlockchain();
  const loadoutString = await contracts.back.Account.methods.getMetadata(address, 'loadout').call();
  let loadout = loadoutString ? JSON.parse(loadoutString) : null;
  if (!Array.isArray(loadout)) {
    loadout = [];
  }
  while (loadout.length < 8) {
    loadout.push(null);
  }
  return loadout;
}

export const setLoadoutState = async (id, index, state) => {
  const { web3, contracts } = await getBlockchain();
  if (!state.loginToken) {
    throw new Error('not logged in');
    return state;
  }

  const hash = await contracts.back.NFT.methods.getHash(id).call();
  const [
    name,
    ext,
  ] = await Promise.all([
    contracts.back.NFT.methods.getMetadata(hash, 'name').call(),
    contracts.back.NFT.methods.getMetadata(hash, 'ext').call(),
  ]);

  // const itemUrl = `${storageHost}/${hash.slice(2)}${ext ? ('.' + ext) : ''}`;
  // const itemFileName = itemUrl.replace(/.*\/([^\/]+)$/, '$1');
  const itemPreview = `${previewHost}/${hash}${ext ? ('.' + ext) : ''}/preview.${previewExt}`;

  const loadout = await getLoadout(state.address);
  loadout.splice(index - 1, 1, [
    id + '',
    name,
    ext,
    itemPreview
  ]);

  await runSidechainTransaction(state.loginToken.mnemonic)('Account', 'setMetadata', state.address, 'loadout', JSON.stringify(loadout));

  return { ...state, loadout: JSON.stringify(loadout) };
};
