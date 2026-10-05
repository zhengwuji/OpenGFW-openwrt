include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-opengfw
PKG_VERSION:=1.0.0
PKG_RELEASE:=1

PKG_LICENSE:=MPL-2.0
PKG_MAINTAINER:=OpenGFW Team

LUCI_TITLE:=LuCI support for OpenGFW deep packet inspection and network filtering engine
LUCI_DEPENDS:=+kmod-nfnetlink-queue +nftables
LUCI_PKGARCH:=all

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
