# Proxmox Node Locations

This document serves as a persistent reference for the physical locations of the PiltiSmart infrastructure nodes.

| Node Name | Location | SDN VNet | Subnet Range | Gateway VMID | Gateway SDN IP | Gateway Tailscale IP |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Purple** | Madurai | `purplevn` | `10.70.70.0/24` | 999 | `10.70.70.3` | `100.118.179.53` |
| **White** | Madurai | `whitevn` | `10.60.60.0/24` | 999 | `10.60.60.4` | `100.68.97.57` |
| **Pluto** | Madurai | `plutovn` | `10.90.90.0/24` | 999 | `10.90.90.3` | `100.98.57.63` |
| **Pink** | Dublin | `pinkvnet` | `10.80.80.0/24` | 399 | `10.80.80.2` | `100.118.72.62` |
| **Gold** | Dublin | `goldvnet` | `10.50.50.0/24` | 999 | `10.50.50.3` | `100.88.139.76` |
| **Silver** | Dublin | `silvervn` | `10.100.100.0/24` | 499 | `10.100.100.2` | `100.72.150.29` |

## Site-to-Site VPN Topology

The following diagram illustrates how the individual Proxmox SDN networks route their internal traffic out to their local Gateway LXCs, which then bridge securely across the Internet via the Tailscale Mesh.

```mermaid
graph TD
    %% Define Styles
    classDef madurai fill:#e6e6fa,stroke:#9370db,stroke-width:2px;
    classDef dublin fill:#f0fff0,stroke:#3cb371,stroke-width:2px;
    classDef sdn fill:#fffacd,stroke:#ffd700,stroke-width:1px;
    classDef gateway fill:#202020,stroke:#ffffff,color:#fff,stroke-width:2px;
    classDef tailscale fill:#1e90ff,stroke:#000,color:#fff,stroke-width:3px;

    %% Internet / VPN Mesh
    TS((Tailscale Mesh<br>100.x.x.x)):::tailscale

    %% Madurai Datacenter
    subgraph Madurai [Madurai Location]
        direction TB
        
        %% Purple Node
        subgraph Purple [Purple Node]
            PG[Purple Gateway LXC]:::gateway
            PSDN[purplevn SDN<br>10.70.70.x]:::sdn
            PSDN -->|Static Route| PG
        end

        %% White Node
        subgraph White [White Node]
            WG[White Gateway LXC]:::gateway
            WSDN[whitevn SDN<br>10.60.60.x]:::sdn
            WSDN -->|Static Route| WG
        end

        %% Pluto Node
        subgraph Pluto [Pluto Node]
            PLG[Pluto Gateway LXC]:::gateway
            PLSDN[plutovn SDN<br>10.90.90.x]:::sdn
            PLSDN -->|Static Route| PLG
        end
    end

    %% Dublin Datacenter
    subgraph Dublin [Dublin Location]
        direction TB

        %% Gold Node
        subgraph Gold [Gold Node]
            GG[Gold Gateway LXC]:::gateway
            GSDN[goldvnet SDN<br>10.50.50.x]:::sdn
            GSDN -->|Static Route| GG
        end

        %% Pink Node
        subgraph Pink [Pink Node]
            PK[Pink Gateway LXC]:::gateway
            PKSDN[pinkvnet SDN<br>10.80.80.x]:::sdn
            PKSDN -->|Static Route| PK
        end

        %% Silver Node
        subgraph Silver [Silver Node]
            SL[Silver Gateway LXC]:::gateway
            SLSDN[silvervn SDN<br>10.100.100.x]:::sdn
            SLSDN -->|Static Route| SL
        end
    end

    %% Connect Gateways to Tailscale
    PG <===> TS
    WG <===> TS
    PLG <===> TS
    GG <===> TS
    PK <===> TS
    SL <===> TS

    %% Apply Classes
    class Madurai madurai;
    class Dublin dublin;
```
