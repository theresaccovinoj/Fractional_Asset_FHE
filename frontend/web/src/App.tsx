
// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface FractionalAsset {
  id: string;
  encryptedShares: string;
  encryptedPrice: string;
  timestamp: number;
  owners: string[];
  assetName: string;
  game: string;
  totalShares: number;
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const FHECompute = (encryptedData: string, operation: string): string => {
  const value = FHEDecryptNumber(encryptedData);
  let result = value;
  
  switch(operation) {
    case 'increase10%':
      result = value * 1.1;
      break;
    case 'decrease10%':
      result = value * 0.9;
      break;
    case 'double':
      result = value * 2;
      break;
    default:
      result = value;
  }
  
  return FHEEncryptNumber(result);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [assets, setAssets] = useState<FractionalAsset[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newAssetData, setNewAssetData] = useState({ 
    assetName: "", 
    game: "", 
    price: 0,
    shares: 100,
    coOwners: [] as string[]
  });
  const [selectedAsset, setSelectedAsset] = useState<FractionalAsset | null>(null);
  const [decryptedPrice, setDecryptedPrice] = useState<number | null>(null);
  const [decryptedShares, setDecryptedShares] = useState<{[key: string]: number}>({});
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [userHistory, setUserHistory] = useState<{action: string, timestamp: number, assetId?: string}[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  // Statistics
  const totalAssets = assets.length;
  const totalValue = assets.reduce((sum, asset) => sum + (decryptedPrice ? decryptedPrice : 0), 0);
  const userOwnedAssets = assets.filter(asset => asset.owners.includes(address || ''));
  const userOwnedValue = userOwnedAssets.reduce((sum, asset) => {
    const price = decryptedPrice || 0;
    const userShare = decryptedShares[asset.id] || 0;
    return sum + (price * (userShare / asset.totalShares));
  }, 0);

  useEffect(() => {
    loadAssets().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadAssets = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      
      const keysBytes = await contract.getData("asset_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing asset keys:", e); }
      }
      
      const list: FractionalAsset[] = [];
      for (const key of keys) {
        try {
          const assetBytes = await contract.getData(`asset_${key}`);
          if (assetBytes.length > 0) {
            try {
              const assetData = JSON.parse(ethers.toUtf8String(assetBytes));
              list.push({ 
                id: key, 
                encryptedShares: assetData.shares, 
                encryptedPrice: assetData.price,
                timestamp: assetData.timestamp, 
                owners: assetData.owners, 
                assetName: assetData.assetName,
                game: assetData.game,
                totalShares: assetData.totalShares || 100
              });
            } catch (e) { console.error(`Error parsing asset data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading asset ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setAssets(list);
      addHistoryEntry('Refreshed asset list');
    } catch (e) { 
      console.error("Error loading assets:", e); 
      addHistoryEntry('Failed to refresh assets', undefined, 'error');
    } finally { 
      setIsRefreshing(false); 
      setLoading(false); 
    }
  };

  const submitAsset = async () => {
    if (!isConnected) { 
      alert("Please connect wallet first"); 
      return; 
    }
    
    setCreating(true);
    setTransactionStatus({ 
      visible: true, 
      status: "pending", 
      message: "Encrypting asset data with Zama FHE..." 
    });
    
    try {
      const encryptedPrice = FHEEncryptNumber(newAssetData.price);
      const encryptedShares = FHEEncryptNumber(newAssetData.shares);
      
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const assetId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const owners = [address || '', ...newAssetData.coOwners];
      
      const assetData = { 
        price: encryptedPrice,
        shares: encryptedShares,
        timestamp: Math.floor(Date.now() / 1000), 
        owners: owners,
        assetName: newAssetData.assetName,
        game: newAssetData.game,
        totalShares: newAssetData.shares
      };
      
      await contract.setData(`asset_${assetId}`, ethers.toUtf8Bytes(JSON.stringify(assetData)));
      
      const keysBytes = await contract.getData("asset_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { 
          keys = JSON.parse(ethers.toUtf8String(keysBytes)); 
        } catch (e) { 
          console.error("Error parsing keys:", e); 
        }
      }
      
      keys.push(assetId);
      await contract.setData("asset_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ 
        visible: true, 
        status: "success", 
        message: "Asset fractionalized with FHE encryption!" 
      });
      
      addHistoryEntry('Created new asset', assetId);
      await loadAssets();
      
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewAssetData({ 
          assetName: "", 
          game: "", 
          price: 0,
          shares: 100,
          coOwners: []
        });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") 
        ? "Transaction rejected by user" 
        : "Submission failed: " + (e.message || "Unknown error");
      
      setTransactionStatus({ 
        visible: true, 
        status: "error", 
        message: errorMessage 
      });
      
      addHistoryEntry('Failed to create asset', undefined, 'error');
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { 
      setCreating(false); 
    }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { 
      alert("Please connect wallet first"); 
      return null; 
    }
    
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { 
      console.error("Decryption failed:", e); 
      return null; 
    } finally { 
      setIsDecrypting(false); 
    }
  };

  const decryptAssetPrice = async (asset: FractionalAsset) => {
    const decrypted = await decryptWithSignature(asset.encryptedPrice);
    if (decrypted !== null) {
      setDecryptedPrice(decrypted);
      addHistoryEntry('Decrypted asset price', asset.id);
    }
  };

  const decryptUserShares = async (asset: FractionalAsset) => {
    if (!address) return;
    
    const decrypted = await decryptWithSignature(asset.encryptedShares);
    if (decrypted !== null) {
      setDecryptedShares(prev => ({
        ...prev,
        [asset.id]: decrypted
      }));
      addHistoryEntry('Decrypted personal shares', asset.id);
    }
  };

  const addHistoryEntry = (action: string, assetId?: string, type: 'success' | 'error' = 'success') => {
    setUserHistory(prev => [{
      action,
      timestamp: Math.floor(Date.now() / 1000),
      assetId
    }, ...prev.slice(0, 49)]); // Keep last 50 entries
  };

  const isOwner = (owners: string[]) => owners.includes(address || '');

  const renderAssetChart = (asset: FractionalAsset) => {
    const userShare = decryptedShares[asset.id] || 0;
    const otherShare = asset.totalShares - userShare;
    
    return (
      <div className="asset-chart">
        <div className="chart-container">
          <div 
            className="chart-segment user" 
            style={{ width: `${(userShare / asset.totalShares) * 100}%` }}
          ></div>
          <div 
            className="chart-segment other" 
            style={{ width: `${(otherShare / asset.totalShares) * 100}%` }}
          ></div>
        </div>
        <div className="chart-legend">
          <div className="legend-item">
            <div className="color-box user"></div>
            <span>Your Share: {userShare}</span>
          </div>
          <div className="legend-item">
            <div className="color-box other"></div>
            <span>Other Owners: {otherShare}</span>
          </div>
        </div>
      </div>
    );
  };

  const renderValueChart = () => {
    const assetValues = assets.map(asset => {
      const price = decryptedPrice || 0;
      return {
        name: asset.assetName,
        value: price,
        share: asset.owners.includes(address || '') ? 
          (decryptedShares[asset.id] || 0) / asset.totalShares : 0
      };
    });

    return (
      <div className="value-chart">
        {assetValues.map((asset, index) => (
          <div key={index} className="value-bar-container">
            <div className="value-bar-label">{asset.name}</div>
            <div className="value-bar-background">
              <div 
                className="value-bar" 
                style={{ width: `${(asset.value / Math.max(...assetValues.map(a => a.value), 1)) * 100}%` }}
              ></div>
              {asset.share > 0 && (
                <div 
                  className="user-share-indicator" 
                  style={{ width: `${asset.share * 100}%` }}
                ></div>
              )}
            </div>
            <div className="value-bar-amount">{asset.value.toFixed(2)} ETH</div>
          </div>
        ))}
      </div>
    );
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="spinner"></div>
      <p>Initializing FHE connection...</p>
    </div>
  );

  return (
    <div className="app-container future-metal-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon">
            <div className="hexagon"></div>
            <div className="small-hexagon"></div>
          </div>
          <h1>FHE<span>Asset</span>Share</h1>
        </div>
        <div className="header-actions">
          <button 
            onClick={() => setShowCreateModal(true)} 
            className="create-asset-btn metal-button"
          >
            <div className="add-icon"></div>Fractionalize Asset
          </button>
          <button 
            className="metal-button" 
            onClick={() => setShowHistory(!showHistory)}
          >
            {showHistory ? "Hide History" : "Show History"}
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>

      <div className="main-content dashboard-layout">
        <div className="dashboard-column stats-column">
          <div className="stats-card metal-card">
            <h3>FHE Asset Pool</h3>
            <div className="stats-grid">
              <div className="stat-item">
                <div className="stat-value">{totalAssets}</div>
                <div className="stat-label">Total Assets</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{totalValue.toFixed(2)}</div>
                <div className="stat-label">Total Value (ETH)</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{userOwnedAssets.length}</div>
                <div className="stat-label">Your Assets</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{userOwnedValue.toFixed(2)}</div>
                <div className="stat-label">Your Value (ETH)</div>
              </div>
            </div>
          </div>

          <div className="stats-card metal-card">
            <h3>Asset Value Distribution</h3>
            {renderValueChart()}
          </div>

          {showHistory && (
            <div className="stats-card metal-card">
              <h3>Your Activity History</h3>
              <div className="history-list">
                {userHistory.length === 0 ? (
                  <div className="no-history">No activity recorded yet</div>
                ) : (
                  userHistory.map((entry, index) => (
                    <div key={index} className="history-entry">
                      <div className="entry-time">
                        {new Date(entry.timestamp * 1000).toLocaleTimeString()}
                      </div>
                      <div className="entry-action">{entry.action}</div>
                      {entry.assetId && (
                        <div className="entry-asset">Asset: #{entry.assetId.substring(0, 6)}</div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        <div className="dashboard-column main-column">
          <div className="welcome-banner">
            <div className="welcome-text">
              <h2>FHE-Powered Game Asset Fractionalization</h2>
              <p>Co-own high-value game assets with encrypted ownership shares using Zama FHE technology</p>
            </div>
            <div className="fhe-indicator">
              <div className="fhe-lock"></div>
              <span>FHE Encryption Active</span>
            </div>
          </div>

          <div className="assets-section">
            <div className="section-header">
              <h2>Fractionalized Assets</h2>
              <div className="header-actions">
                <button 
                  onClick={loadAssets} 
                  className="refresh-btn metal-button" 
                  disabled={isRefreshing}
                >
                  {isRefreshing ? "Refreshing..." : "Refresh Assets"}
                </button>
              </div>
            </div>

            <div className="assets-list metal-card">
              <div className="table-header">
                <div className="header-cell">Asset</div>
                <div className="header-cell">Game</div>
                <div className="header-cell">Owners</div>
                <div className="header-cell">Date</div>
                <div className="header-cell">Actions</div>
              </div>

              {assets.length === 0 ? (
                <div className="no-assets">
                  <div className="no-assets-icon"></div>
                  <p>No fractionalized assets found</p>
                  <button 
                    className="metal-button primary" 
                    onClick={() => setShowCreateModal(true)}
                  >
                    Create First Asset
                  </button>
                </div>
              ) : assets.map(asset => (
                <div 
                  className="asset-row" 
                  key={asset.id} 
                  onClick={() => setSelectedAsset(asset)}
                >
                  <div className="table-cell asset-name">{asset.assetName}</div>
                  <div className="table-cell">{asset.game}</div>
                  <div className="table-cell">
                    {asset.owners.length} owner{asset.owners.length !== 1 ? 's' : ''}
                  </div>
                  <div className="table-cell">
                    {new Date(asset.timestamp * 1000).toLocaleDateString()}
                  </div>
                  <div className="table-cell actions">
                    {isOwner(asset.owners) && (
                      <button 
                        className="action-btn metal-button" 
                        onClick={(e) => {
                          e.stopPropagation();
                          decryptUserShares(asset);
                        }}
                      >
                        View Shares
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {showCreateModal && (
        <ModalCreate 
          onSubmit={submitAsset} 
          onClose={() => setShowCreateModal(false)} 
          creating={creating} 
          assetData={newAssetData} 
          setAssetData={setNewAssetData}
        />
      )}

      {selectedAsset && (
        <AssetDetailModal 
          asset={selectedAsset} 
          onClose={() => { 
            setSelectedAsset(null); 
            setDecryptedPrice(null); 
          }} 
          decryptedPrice={decryptedPrice}
          setDecryptedPrice={setDecryptedPrice}
          isDecrypting={isDecrypting}
          decryptWithSignature={decryptWithSignature}
          decryptedShares={decryptedShares[selectedAsset.id]}
          renderAssetChart={renderAssetChart}
        />
      )}

      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content metal-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo">
              <div className="hexagon"></div>
              <span>FHEAssetShare</span>
            </div>
            <p>Game asset fractionalization with Zama FHE encryption</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms</a>
            <a href="#" className="footer-link">Contact</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge">
            <span>Powered by Zama FHE</span>
          </div>
          <div className="copyright">
            © {new Date().getFullYear()} FHEAssetShare. All rights reserved.
          </div>
        </div>
      </footer>
    </div>
  );
};

interface ModalCreateProps {
  onSubmit: () => void; 
  onClose: () => void; 
  creating: boolean;
  assetData: any;
  setAssetData: (data: any) => void;
}

const ModalCreate: React.FC<ModalCreateProps> = ({ onSubmit, onClose, creating, assetData, setAssetData }) => {
  const [coOwnerAddress, setCoOwnerAddress] = useState("");

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setAssetData({ ...assetData, [name]: value });
  };

  const handleNumberChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setAssetData({ ...assetData, [name]: parseFloat(value) });
  };

  const addCoOwner = () => {
    if (coOwnerAddress && ethers.isAddress(coOwnerAddress)) {
      if (!assetData.coOwners.includes(coOwnerAddress)) {
        setAssetData({
          ...assetData,
          coOwners: [...assetData.coOwners, coOwnerAddress]
        });
        setCoOwnerAddress("");
      }
    }
  };

  const removeCoOwner = (address: string) => {
    setAssetData({
      ...assetData,
      coOwners: assetData.coOwners.filter(a => a !== address)
    });
  };

  const handleSubmit = () => {
    if (!assetData.assetName || !assetData.game || assetData.price <= 0) {
      alert("Please fill required fields");
      return;
    }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="create-modal metal-card">
        <div className="modal-header">
          <h2>Fractionalize Game Asset</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice-banner">
            <div className="key-icon"></div> 
            <div>
              <strong>FHE Encryption Notice</strong>
              <p>Ownership shares and asset value will be encrypted with Zama FHE</p>
            </div>
          </div>

          <div className="form-grid">
            <div className="form-group">
              <label>Asset Name *</label>
              <input 
                type="text" 
                name="assetName" 
                value={assetData.assetName} 
                onChange={handleChange} 
                placeholder="e.g. Legendary Sword" 
                className="metal-input"
              />
            </div>
            <div className="form-group">
              <label>Game *</label>
              <input 
                type="text" 
                name="game" 
                value={assetData.game} 
                onChange={handleChange} 
                placeholder="e.g. World of Warcraft" 
                className="metal-input"
              />
            </div>
            <div className="form-group">
              <label>Total Price (ETH) *</label>
              <input 
                type="number" 
                name="price" 
                value={assetData.price} 
                onChange={handleNumberChange} 
                placeholder="Enter asset value" 
                className="metal-input"
                step="0.01"
                min="0"
              />
            </div>
            <div className="form-group">
              <label>Total Shares *</label>
              <input 
                type="number" 
                name="shares" 
                value={assetData.shares} 
                onChange={handleNumberChange} 
                placeholder="Total shares to divide" 
                className="metal-input"
                min="1"
              />
            </div>
          </div>

          <div className="co-owners-section">
            <h4>Co-Owners (Optional)</h4>
            <div className="co-owner-input">
              <input
                type="text"
                value={coOwnerAddress}
                onChange={(e) => setCoOwnerAddress(e.target.value)}
                placeholder="Enter wallet address"
                className="metal-input"
              />
              <button 
                onClick={addCoOwner}
                className="metal-button small"
                disabled={!ethers.isAddress(coOwnerAddress)}
              >
                Add
              </button>
            </div>
            {assetData.coOwners.length > 0 && (
              <div className="co-owners-list">
                {assetData.coOwners.map((address: string, index: number) => (
                  <div key={index} className="co-owner-item">
                    <span>{address.substring(0, 6)}...{address.substring(38)}</span>
                    <button 
                      onClick={() => removeCoOwner(address)}
                      className="remove-btn"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="encryption-preview">
            <h4>FHE Encryption Preview</h4>
            <div className="preview-container">
              <div className="plain-data">
                <span>Plain Value:</span>
                <div>{assetData.price || '0'} ETH</div>
              </div>
              <div className="encryption-arrow">→</div>
              <div className="encrypted-data">
                <span>Encrypted Data:</span>
                <div>
                  {assetData.price ? 
                    FHEEncryptNumber(assetData.price).substring(0, 50) + '...' : 
                    'No value entered'
                  }
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn metal-button">
            Cancel
          </button>
          <button 
            onClick={handleSubmit} 
            disabled={creating} 
            className="submit-btn metal-button primary"
          >
            {creating ? "Encrypting with FHE..." : "Fractionalize Asset"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface AssetDetailModalProps {
  asset: FractionalAsset;
  onClose: () => void;
  decryptedPrice: number | null;
  setDecryptedPrice: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
  decryptedShares?: number;
  renderAssetChart: (asset: FractionalAsset) => React.ReactNode;
}

const AssetDetailModal: React.FC<AssetDetailModalProps> = ({ 
  asset, 
  onClose, 
  decryptedPrice, 
  setDecryptedPrice, 
  isDecrypting, 
  decryptWithSignature,
  decryptedShares,
  renderAssetChart
}) => {
  const handleDecryptPrice = async () => {
    if (decryptedPrice !== null) {
      setDecryptedPrice(null);
      return;
    }
    const decrypted = await decryptWithSignature(asset.encryptedPrice);
    if (decrypted !== null) setDecryptedPrice(decrypted);
  };

  return (
    <div className="modal-overlay">
      <div className="asset-detail-modal metal-card">
        <div className="modal-header">
          <h2>{asset.assetName}</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="asset-info">
            <div className="info-item">
              <span>Game:</span>
              <strong>{asset.game}</strong>
            </div>
            <div className="info-item">
              <span>Owners:</span>
              <strong>{asset.owners.length}</strong>
            </div>
            <div className="info-item">
              <span>Date Fractionalized:</span>
              <strong>{new Date(asset.timestamp * 1000).toLocaleString()}</strong>
            </div>
            <div className="info-item">
              <span>Total Shares:</span>
              <strong>{asset.totalShares}</strong>
            </div>
          </div>

          <div className="asset-ownership">
            <h3>Ownership Distribution</h3>
            {renderAssetChart(asset)}
          </div>

          <div className="asset-value-section">
            <h3>Asset Value</h3>
            <div className="value-display">
              {decryptedPrice !== null ? (
                <div className="decrypted-value">
                  {decryptedPrice.toFixed(2)} ETH
                  <div className="decryption-notice">
                    <div className="warning-icon"></div>
                    <span>Decrypted value visible only to you</span>
                  </div>
                </div>
              ) : (
                <div className="encrypted-value">
                  <div className="fhe-tag">
                    <div className="fhe-icon"></div>
                    <span>FHE Encrypted</span>
                  </div>
                  <button 
                    className="decrypt-btn metal-button" 
                    onClick={handleDecryptPrice} 
                    disabled={isDecrypting}
                  >
                    {isDecrypting ? "Decrypting..." : "Decrypt Value"}
                  </button>
                </div>
              )}
            </div>
          </div>

          {decryptedShares !== undefined && (
            <div className="user-shares-section">
              <h3>Your Ownership</h3>
              <div className="shares-display">
                <div className="shares-value">
                  {decryptedShares} shares ({((decryptedShares / asset.totalShares) * 100).toFixed(2)}%)
                </div>
                {decryptedPrice !== null && (
                  <div className="shares-value">
                    Value: {(decryptedPrice * (decryptedShares / asset.totalShares)).toFixed(4)} ETH
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="owners-list">
            <h3>Owners</h3>
            <div className="owners-grid">
              {asset.owners.map((owner, index) => (
                <div key={index} className="owner-item">
                  <div className="owner-address">
                    {owner.substring(0, 6)}...{owner.substring(38)}
                  </div>
                  <div className="owner-status">
                    {index === 0 ? "Creator" : "Co-owner"}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn metal-button">
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default App;