package geo

import (
	"bytes"
	"errors"
	"net"
	"regexp"
	"slices"
	"strings"

	"github.com/apernet/OpenGFW/ruleset/builtins/geo/v2geo"
)

var _ hostMatcher = (*geoipMatcher)(nil)

type geoipMatcher struct {
	N4      []*net.IPNet // sorted
	N6      []*net.IPNet // sorted
	Inverse bool
}

// matchIP tries to match the given IP address with the corresponding IPNets.
// Note that this function does NOT handle the Inverse flag.
func (m *geoipMatcher) matchIP(ip net.IP) bool {
	var n []*net.IPNet
	if ip4 := ip.To4(); ip4 != nil {
		// N4 stores IPv4 addresses in 4-byte form.
		// Make sure we use it here too, otherwise bytes.Compare will fail.
		ip = ip4
		n = m.N4
	} else {
		n = m.N6
	}
	left, right := 0, len(n)-1
	for left <= right {
		mid := (left + right) / 2
		if n[mid].Contains(ip) {
			return true
		} else if bytes.Compare(n[mid].IP, ip) < 0 {
			left = mid + 1
		} else {
			right = mid - 1
		}
	}
	return false
}

func (m *geoipMatcher) Match(host HostInfo) bool {
	if host.IPv4 != nil {
		if m.matchIP(host.IPv4) {
			return !m.Inverse
		}
	}
	if host.IPv6 != nil {
		if m.matchIP(host.IPv6) {
			return !m.Inverse
		}
	}
	return m.Inverse
}

func newGeoIPMatcher(list *v2geo.GeoIP) (*geoipMatcher, error) {
	n4 := make([]*net.IPNet, 0)
	n6 := make([]*net.IPNet, 0)
	for _, cidr := range list.Cidr {
		if len(cidr.Ip) == 4 {
			// IPv4
			n4 = append(n4, &net.IPNet{
				IP:   cidr.Ip,
				Mask: net.CIDRMask(int(cidr.Prefix), 32),
			})
		} else if len(cidr.Ip) == 16 {
			// IPv6
			n6 = append(n6, &net.IPNet{
				IP:   cidr.Ip,
				Mask: net.CIDRMask(int(cidr.Prefix), 128),
			})
		} else {
			return nil, errors.New("invalid IP length")
		}
	}
	// Sort the IPNets, so we can do binary search later.
	slices.SortFunc(n4, func(a, b *net.IPNet) int {
		return bytes.Compare(a.IP, b.IP)
	})
	slices.SortFunc(n6, func(a, b *net.IPNet) int {
		return bytes.Compare(a.IP, b.IP)
	})
	return &geoipMatcher{
		N4:      n4,
		N6:      n6,
		Inverse: list.InverseMatch,
	}, nil
}

var _ hostMatcher = (*geositeMatcher)(nil)

type geositeMatcher struct {
	exactDomains map[string]struct{}
	rootDomains  map[string]struct{}
	plainDomains []string
	regexDomains []*regexp.Regexp
}

func (m *geositeMatcher) Match(host HostInfo) bool {
	name := strings.ToLower(strings.TrimSpace(host.Name))
	name = strings.Trim(name, ".")
	if name == "" {
		return false
	}

	// 1. Exact match (O(1)): covers Full domains and exact Root domains
	if len(m.exactDomains) > 0 {
		if _, ok := m.exactDomains[name]; ok {
			return true
		}
	}

	// 2. Root domain match (O(L)): checks every parent domain suffix
	if len(m.rootDomains) > 0 {
		for i := 0; i < len(name); i++ {
			if name[i] == '.' {
				sub := name[i+1:]
				if sub != "" && sub[0] != '.' {
					if _, ok := m.rootDomains[sub]; ok {
						return true
					}
				}
			}
		}
	}

	// 3. Plain (substring) match
	for _, plain := range m.plainDomains {
		if strings.Contains(name, plain) {
			return true
		}
	}

	// 4. Regex match
	for _, re := range m.regexDomains {
		if re.MatchString(name) {
			return true
		}
	}

	return false
}

func domainMatchesAttrs(domainAttrs []*v2geo.Domain_Attribute, reqAttrs []string) bool {
	if len(reqAttrs) == 0 {
		return true
	}
	if len(domainAttrs) == 0 {
		return false
	}
	attrMap := make(map[string]bool, len(domainAttrs))
	for _, attr := range domainAttrs {
		attrMap[attr.Key] = true
	}
	for _, req := range reqAttrs {
		if !attrMap[req] {
			return false
		}
	}
	return true
}

func newGeositeMatcher(list *v2geo.GeoSite, attrs []string) (*geositeMatcher, error) {
	exactDomains := make(map[string]struct{})
	rootDomains := make(map[string]struct{})
	var plainDomains []string
	var regexDomains []*regexp.Regexp

	for _, domain := range list.Domain {
		if !domainMatchesAttrs(domain.Attribute, attrs) {
			continue
		}

		val := strings.ToLower(strings.TrimSpace(domain.Value))
		val = strings.Trim(val, ".")

		switch domain.Type {
		case v2geo.Domain_Plain:
			if val != "" {
				plainDomains = append(plainDomains, val)
			}
		case v2geo.Domain_Regex:
			regex, err := regexp.Compile(domain.Value)
			if err != nil {
				return nil, err
			}
			regexDomains = append(regexDomains, regex)
		case v2geo.Domain_Full:
			if val != "" {
				exactDomains[val] = struct{}{}
			}
		case v2geo.Domain_RootDomain:
			if val != "" {
				exactDomains[val] = struct{}{}
				rootDomains[val] = struct{}{}
			}
		default:
			return nil, errors.New("unsupported domain type")
		}
	}

	return &geositeMatcher{
		exactDomains: exactDomains,
		rootDomains:  rootDomains,
		plainDomains: plainDomains,
		regexDomains: regexDomains,
	}, nil
}
